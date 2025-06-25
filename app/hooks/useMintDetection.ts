'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createJupiterApiClient } from '@jup-ag/api'
import HeliusConnection from '../services/HeliusConnection'

export interface NewToken {
  mint: string
  timestamp: number
  signature: string
  creator?: string
  name?: string
  symbol?: string
  supply?: number
  marketStatus?: 'checking' | 'available' | 'not-available' | 'error'
  lastMarketCheck?: number
  marketCheckCount?: number
}

export interface SnipedToken extends NewToken {
  snipedAt: number
  snipeAmount?: number
  snipePrice?: number
  snipeSignature?: string
}

export const useMintDetection = (connection: Connection | null, isMonitoring: boolean) => {
  // Ref to track if component is still mounted
  const isMountedRef = useRef(true)
  
  // LocalStorage keys
  const DETECTED_TOKENS_KEY = 'solsniperbot_detected_tokens'
  const SNIPED_TOKENS_KEY = 'solsniperbot_sniped_tokens'

  // Load initial state from localStorage
  const loadDetectedTokens = (): NewToken[] => {
    if (typeof window === 'undefined') return []
    try {
      const stored = localStorage.getItem(DETECTED_TOKENS_KEY)
      return stored ? JSON.parse(stored) : []
    } catch (error) {
      console.warn('Failed to load detected tokens from localStorage:', error)
      return []
    }
  }

  const loadSnipedTokens = (): SnipedToken[] => {
    if (typeof window === 'undefined') return []
    try {
      const stored = localStorage.getItem(SNIPED_TOKENS_KEY)
      return stored ? JSON.parse(stored) : []
    } catch (error) {
      console.warn('Failed to load sniped tokens from localStorage:', error)
      return []
    }
  }

  // Save functions
  const saveDetectedTokens = (tokens: NewToken[]) => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(DETECTED_TOKENS_KEY, JSON.stringify(tokens))
    } catch (error) {
      console.warn('Failed to save detected tokens to localStorage:', error)
    }
  }

  const saveSnipedTokens = (tokens: SnipedToken[]) => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(SNIPED_TOKENS_KEY, JSON.stringify(tokens))
    } catch (error) {
      console.warn('Failed to save sniped tokens to localStorage:', error)
    }
  }

  const [detectedTokens, setDetectedTokens] = useState<NewToken[]>(loadDetectedTokens)
  const [snipedTokens, setSnipedTokens] = useState<SnipedToken[]>(loadSnipedTokens)
  const [subscriptionId, setSubscriptionId] = useState<number | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [heartbeatCount, setHeartbeatCount] = useState(0)
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(0)
  const [accountsProcessed, setAccountsProcessed] = useState(0)
  const [pollingResults, setPollingResults] = useState(0)
  const [intervals, setIntervals] = useState<{ heartbeat?: NodeJS.Timeout; polling?: NodeJS.Timeout; marketCheck?: NodeJS.Timeout; healthCheck?: NodeJS.Timeout }>({})
  const [marketCheckQueue, setMarketCheckQueue] = useState<Set<string>>(new Set())
  const [rateLimitBackoff, setRateLimitBackoff] = useState<number>(0) // Backoff counter for rate limiting
  const [lastMarketCheckTime, setLastMarketCheckTime] = useState<number>(0) // Track last market check time
  const [lastRpcCallTime, setLastRpcCallTime] = useState<number>(0) // Track last RPC call to avoid Helius rate limits

  // Sync to localStorage when state changes
  useEffect(() => {
    saveDetectedTokens(detectedTokens)
  }, [detectedTokens])

  useEffect(() => {
    saveSnipedTokens(snipedTokens)
  }, [snipedTokens])

  // Restore market check queue for tokens that need checking
  useEffect(() => {
    console.log('🔧 Restoring market check queue on mount...')
    console.log(`📊 Current detected tokens: ${detectedTokens.length}`)
    
    const tokensNeedingCheck = detectedTokens.filter(token => {
      // Only add valid tokens to queue
      try {
        new PublicKey(token.mint)
        const needsCheck = token.marketStatus !== 'available' && 
                          (token.marketCheckCount || 0) < 10 && // Reduced from 15 to 10 to limit API calls
                          token.mint.length >= 32
        
        console.log(`🔍 Token ${token.mint.slice(0, 8)}:`, {
          marketStatus: token.marketStatus,
          checkCount: token.marketCheckCount || 0,
          needsCheck
        })
        
        return needsCheck
      } catch {
        console.log(`❌ Invalid token format: ${token.mint}`)
        return false // Skip invalid mint addresses
      }
    })
    
    console.log(`📥 Found ${tokensNeedingCheck.length} tokens needing market checks`)
    
    if (tokensNeedingCheck.length > 0) {
      setMarketCheckQueue(prev => {
        const newQueue = new Set(prev)
        tokensNeedingCheck.forEach(token => {
          newQueue.add(token.mint)
          console.log(`📥 Restored ${token.mint.slice(0, 8)} to market check queue`)
        })
        console.log(`📊 Total queue size after restore: ${newQueue.size}`)
        return newQueue
      })
    } else {
      console.log('📭 No tokens need market checking')
    }
  }, []) // Only run once on mount

  // Jupiter API client for market checking (memoized to prevent re-creation)
  const jupiterApi = useMemo(() => createJupiterApiClient(), [])
  const SOL_MINT = 'So11111111111111111111111111111111111111112'

  // Wrapper function for Jupiter API calls with built-in retry and rate limiting
  const callJupiterWithRetry = useCallback(async (apiCall: () => Promise<any>, maxRetries = 2): Promise<any> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await apiCall()
        return result
      } catch (error: any) {
        const errorMessage = error?.message || error?.toString() || 'Unknown error'
        
        if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Rate limit')) {
          if (attempt < maxRetries) {
            const delay = attempt * 3000 // 3s, 6s delays
            console.log(`⏱️ Rate limited on attempt ${attempt}, waiting ${delay}ms before retry...`)
            await new Promise(resolve => setTimeout(resolve, delay))
            continue
          }
        }
        
        // Re-throw error if not rate limit or max retries reached
        throw error
      }
    }
  }, [])

  // Check if a token is tradeable on Jupiter
  const checkTokenMarket = useCallback(async (mintAddress: string): Promise<'available' | 'not-available' | 'error'> => {
    try {
      console.log(`🔍 Checking market for token: ${mintAddress.slice(0, 8)}...`)
      
      // Validate mint address format first
      try {
        new PublicKey(mintAddress)
      } catch (error) {
        console.log(`❌ Invalid mint address format: ${mintAddress.slice(0, 8)}...`)
        return 'error'
      }
      
      // Skip known system tokens that might cause issues
      const systemTokens = [
        '11111111111111111111111111111111', // System Program
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' // Associated Token Program
      ]
      
      if (systemTokens.includes(mintAddress)) {
        console.log(`⚠️ Skipping system token: ${mintAddress.slice(0, 8)}...`)
        return 'not-available'
      }

      // First try: Simple quote with minimal parameters (with retry logic)
      try {
        const testQuote = await callJupiterWithRetry(async () => {
          return await jupiterApi.quoteGet({
            inputMint: SOL_MINT,
            outputMint: mintAddress,
            amount: 1000000, // 0.001 SOL
            slippageBps: 10000 // 100% max slippage for very new tokens
          })
        })
        
        if (testQuote && testQuote.outAmount && parseInt(testQuote.outAmount) > 0) {
          console.log(`✅ Market found for token: ${mintAddress.slice(0, 8)}... (Output: ${testQuote.outAmount})`)
          return 'available'
        }
      } catch (quoteError: any) {
        // If first attempt fails, try with different parameters
        console.log(`🔄 First quote attempt failed, trying alternative...`)
        
        try {
          const altQuote = await callJupiterWithRetry(async () => {
            return await jupiterApi.quoteGet({
              inputMint: mintAddress,
              outputMint: SOL_MINT, // Try reverse direction
              amount: 1000000, // 1 million base units of the token
              slippageBps: 10000
            })
          })
          
          if (altQuote && altQuote.outAmount && parseInt(altQuote.outAmount) > 0) {
            console.log(`✅ Market found for token (reverse): ${mintAddress.slice(0, 8)}...`)
            return 'available'
          }
        } catch (altError) {
          console.log(`⏳ No market routes found for token: ${mintAddress.slice(0, 8)}...`)
        }
      }
      
      return 'not-available'
      
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || 'Unknown error'
      
      // Handle specific Jupiter API errors
      if (errorMessage.includes('400') || errorMessage.includes('Bad Request')) {
        console.log(`⚠️ Bad request for token: ${mintAddress.slice(0, 8)}... (Token likely not tradeable yet)`)
        return 'not-available'
      } else if (errorMessage.includes('No routes found') || errorMessage.includes('No route found')) {
        console.log(`⏳ No routes found for token: ${mintAddress.slice(0, 8)}...`)
        return 'not-available'
      } else if (errorMessage.includes('429') || errorMessage.includes('Rate limit') || errorMessage.includes('rate limited')) {
        console.log(`⏱️ Rate limited for token: ${mintAddress.slice(0, 8)}... (Will retry later)`)
        return 'error'
      } else {
        console.log(`❌ Error checking market for token: ${mintAddress.slice(0, 8)}...`, errorMessage)
        return 'error'
      }
    }
  }, [callJupiterWithRetry]) // Removed jupiterApi dependency (now memoized)

  // Process market check queue
  const processMarketCheckQueue = useCallback(async () => {
    // Get current queue state
    let currentQueue: Set<string> = new Set()
    
    setMarketCheckQueue(prev => {
      currentQueue = new Set(prev)
      return prev // Don't change the queue here
    })
    
    if (currentQueue.size === 0) {
      console.log('🔍 Market check queue is empty, skipping...')
      return
    }

    // Check if we're in backoff mode using state callback
    let shouldSkipBackoff = false
    setRateLimitBackoff(prev => {
      if (prev > 0) {
        const backoffTime = Math.min(prev * 60000, 600000) // 1 min per level, max 10 minutes
        console.log(`⏱️ Rate limit backoff active: waiting ${backoffTime/1000}s before next check...`)
        shouldSkipBackoff = true
      }
      return prev // Don't change backoff here
    })
    
    if (shouldSkipBackoff) return

    // Check minimum interval using state callback
    let shouldSkipTiming = false
    const now = Date.now()
    setLastMarketCheckTime(prev => {
      if (now - prev < 30000) {
        console.log(`⏱️ Rate limiting: only ${Math.round((now - prev)/1000)}s since last check, waiting...`)
        shouldSkipTiming = true
        return prev // Don't update if skipping
      }
      return now // Update time if proceeding
    })
    
    if (shouldSkipTiming) return

    console.log(`🔄 Processing market check queue: ${currentQueue.size} tokens`)
    
    // Process only 1 token at a time to avoid rate limiting and 400 errors
    const tokensToCheck = Array.from(currentQueue).slice(0, 1)
    if (tokensToCheck.length === 0) return
    
    const mintAddress = tokensToCheck[0]
    console.log(`🎯 Checking token: ${mintAddress.slice(0, 8)}...`)
    
    try {
      // Add extra validation before checking
      if (!mintAddress || mintAddress.length < 32) {
        console.log(`⚠️ Invalid mint address format, removing from queue: ${mintAddress}`)
        setMarketCheckQueue(prev => {
          const newQueue = new Set(prev)
          newQueue.delete(mintAddress)
          return newQueue
        })
        return
      }
      
      console.log(`🔍 Starting market check for: ${mintAddress.slice(0, 8)}...`)
      
      const marketStatus = await checkTokenMarket(mintAddress)
      console.log(`📊 Market check result for ${mintAddress.slice(0, 8)}: ${marketStatus}`)
      
      // Reset or increase backoff based on result
      if (marketStatus !== 'error') {
        setRateLimitBackoff(0)
      } else {
        setRateLimitBackoff(prev => {
          const newBackoff = prev + 1
          console.log(`⏱️ Increased rate limit backoff to level ${newBackoff}`)
          return newBackoff
        })
      }
      
      // Update token status and check if should remove from queue in one operation
      let shouldRemove = false
      
      setDetectedTokens(prev => {
        const updated = prev.map(token => {
          if (token.mint === mintAddress) {
            const updatedToken = {
              ...token,
              marketStatus,
              lastMarketCheck: Date.now(),
              marketCheckCount: (token.marketCheckCount || 0) + 1
            }
            
            console.log(`📝 Updated token ${mintAddress.slice(0, 8)}:`, {
              marketStatus: updatedToken.marketStatus,
              checkCount: updatedToken.marketCheckCount
            })
            
            // Check if we should remove from queue based on updated count
            shouldRemove = marketStatus === 'available' || updatedToken.marketCheckCount >= 10
            
            return updatedToken
          }
          return token
        })
        
        return updated
      })
      
      if (shouldRemove) {
        setMarketCheckQueue(prev => {
          const newQueue = new Set(prev)
          newQueue.delete(mintAddress)
          console.log(`📤 Removed ${mintAddress.slice(0, 8)} from queue (${marketStatus === 'available' ? 'available' : 'max attempts'})`)
          console.log(`📊 Queue size after removal: ${newQueue.size}`)
          return newQueue
        })
      } else {
        console.log(`🔄 Keeping ${mintAddress.slice(0, 8)} in queue for next check`)
      }
      
      // Longer delay between checks to avoid rate limiting (increased to 10s)
      await new Promise(resolve => setTimeout(resolve, 10000))
      
    } catch (error) {
      console.error(`❌ Error in market check for ${mintAddress}:`, error)
      
      // Remove problematic tokens from queue
      setMarketCheckQueue(prev => {
        const newQueue = new Set(prev)
        newQueue.delete(mintAddress)
        console.log(`📤 Removed ${mintAddress.slice(0, 8)} from queue due to error`)
        return newQueue
      })
    }
    
    console.log(`✅ Market check queue processing completed.`)
  }, [checkTokenMarket]) // Removed rateLimitBackoff and lastMarketCheckTime dependencies

  const processNewToken = useCallback(async (logs: any, context: any) => {
    try {
      // Count transaction log events (only if still mounted)
      if (isMountedRef.current) {
        setAccountsProcessed(prev => prev + 1)
      }
      
      // Check if this transaction contains InitializeMint
      const hasInit = logs.logs.find((l: string) => l.includes("InitializeMint"))
      if (!hasInit) return

      console.log('🔔 InitializeMint detected in slot', logs.slot)
      console.log('  Signature:', logs.signature)

      // Skip some transactions randomly to reduce RPC load (process ~70% of transactions)
      if (Math.random() < 0.3) {
        console.log('⏱️ Randomly skipping transaction to reduce RPC load')
        return
      }

      try {
        const activeConnection = connection || HeliusConnection.getRpcConnection()
        
        // Rate limit RPC calls to avoid Helius 429 errors
        const now = Date.now()
        // Use a ref to track last RPC call time to avoid triggering useCallback
        if (now - lastRpcCallTime < 2000) { // Minimum 2 seconds between RPC calls
          console.log('⏱️ Rate limiting RPC call, skipping this transaction to avoid 429...')
          return
        }
        // Update using state setter with callback to avoid dependency
        setLastRpcCallTime(now)
        
        // Get the parsed transaction with maxSupportedTransactionVersion
        console.log('📝 Fetching parsed transaction...')
        const parsedTx = await activeConnection.getParsedTransaction(
          logs.signature,
          {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          }
        )
        
        if (!parsedTx) {
          console.warn('⚠️ Parsed transaction not found for signature:', logs.signature)
          return
        }

        console.log('📄 Parsed transaction retrieved successfully')
        console.log('📋 Instructions found:', parsedTx.transaction.message.instructions.length)
        
        // Log all instructions to debug
        parsedTx.transaction.message.instructions.forEach((ix: any, index: number) => {
          console.log(`  Instruction ${index}:`, {
            program: ix.program,
            parsed: ix.parsed?.type,
            programId: ix.programId?.toString()
          })
        })

        // Find the initializeMint instruction
        const initInstr = parsedTx.transaction.message.instructions.find(
          (ix: any) =>
            ix.program === "spl-token" &&
            ix.parsed?.type === "initializeMint"
        ) as any
        
        if (!initInstr || !initInstr.parsed) {
          console.warn('⚠️ initializeMint instruction not found in parsedTx')
          console.log('📝 Available spl-token instructions:')
          parsedTx.transaction.message.instructions
            .filter((ix: any) => ix.program === "spl-token")
            .forEach((ix: any, index: number) => {
              console.log(`  SPL Token instruction ${index}:`, ix.parsed?.type, ix.parsed?.info)
            })
          return
        }

        // Extract mint address from parsed info
        const mintAddress = initInstr.parsed.info.mint as string
        console.log('✅ NEW MINT ADDRESS:', mintAddress)
        console.log('📋 Full instruction info:', initInstr.parsed.info)

        const newToken: NewToken = {
          mint: mintAddress,
          timestamp: Date.now(),
          signature: logs.signature,
          creator: 'InitializeMint',
          name: `Token-${mintAddress.slice(0, 8)}`,
          symbol: 'NEW',
          supply: 0,
          marketStatus: 'checking',
          lastMarketCheck: 0,
          marketCheckCount: 0
        }

        console.log('🔄 Adding token to state:', newToken)
        
        // Only update state if component is still mounted
        if (!isMountedRef.current) {
          console.log('⚠️ Component unmounted, skipping state update')
          return
        }
        
        setDetectedTokens(prev => {
          console.log('📊 Current tokens in state:', prev.length)
          const isDuplicate = prev.some(token => token.mint === mintAddress)
          if (isDuplicate) {
            console.log('⚠️ Duplicate token detected, skipping:', mintAddress)
            return prev
          }
          
          console.log('🎉 NEW TOKEN ADDED TO STATE:', mintAddress)
          
          // Add to market check queue (only if still mounted)
          if (isMountedRef.current) {
            setMarketCheckQueue(prevQueue => {
              const newQueue = new Set(prevQueue)
              newQueue.add(mintAddress)
              console.log('📈 Added to market check queue:', mintAddress.slice(0, 8))
              return newQueue
            })
          }
          
          const newState = [newToken, ...prev].slice(0, 20)
          console.log('📊 New state length:', newState.length)
          return newState
        })

      } catch (error) {
        console.log('⚠️ Error processing transaction:', error)
        console.log('📋 Error details:', {
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          signature: logs.signature
        })
      }
    } catch (error) {
      console.error('Error processing mint detection:', error)
      console.error('📋 Outer error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        logs: logs
      })
    }
  }, [connection]) // Removed lastRpcCallTime dependency

  // Light polling backup method (with rate limiting)
  const pollForNewMints = useCallback(async () => {
    try {
      const activeConnection = connection || HeliusConnection.getRpcConnection()
      
      // Rate limit polling calls using state setter callback to avoid dependency
      const now = Date.now()
      
      // Check if enough time has passed since last RPC call
      let shouldSkip = false
      setLastRpcCallTime(prev => {
        if (now - prev < 5000) { // Minimum 5 seconds between polling calls
          shouldSkip = true
          return prev // Don't update if skipping
        }
        return now // Update if proceeding
      })
      
      if (shouldSkip) {
        console.log('⏱️ Rate limiting polling call to avoid Helius 429...')
        return
      }
      
      // Check recent signatures (light method)
      try {
        const signatures = await activeConnection.getSignaturesForAddress(
          TOKEN_PROGRAM_ID,
          { limit: 3 } // Reduced from 5 to 3 to minimize RPC usage
        )
        
        // Only update state if component is still mounted
        if (isMountedRef.current) {
          setPollingResults(signatures.length)
        }
        
      } catch (error) {
        if (isMountedRef.current) {
          setPollingResults(prev => prev + 1)
        }
      }
      
    } catch (error) {
      // Silent polling errors
    }
  }, [connection]) // Removed lastRpcCallTime dependency

  const startMonitoring = useCallback(async () => {
    // Direct check instead of state callback since isMonitoring is in dependencies
    if (!isMonitoring) {
      console.log('🛑 Not starting monitoring - isMonitoring is false')
      return
    }

    // Check if we already have a subscription
    let currentSubscriptionId: number | null = null
    setSubscriptionId(prev => {
      if (prev !== null) {
        console.log('🛑 Not starting monitoring - already have subscription:', prev)
        currentSubscriptionId = prev
      }
      return prev
    })
    
    if (currentSubscriptionId !== null) return

    // Use dedicated WebSocket connection for subscriptions
    const activeConnection = connection || HeliusConnection.getWebSocketConnection()

    try {
      console.log('🔍 Starting mint detection with onLogs...')
      
      // Validate configuration without making RPC calls
      const configValid = HeliusConnection.validateConfiguration()
      if (!configValid) {
        console.warn('⚠️ Helius configuration may not be properly set up')
      } else {
        console.log('✅ Helius configuration validated')
      }

      // Setup transaction logs listener with error wrapper
      console.log('📡 Setting up onLogs listener for InitializeMint...')
      
      // Clear any existing subscription first
      if (currentSubscriptionId) {
        try {
          await HeliusConnection.safeRemoveSubscription(currentSubscriptionId)
          console.log('🧹 Cleared existing subscription before creating new one')
        } catch (error) {
          console.warn('⚠️ Could not clear existing subscription (may be already gone):', error)
        }
        setSubscriptionId(null)
      }
      
      let retryCount = 0
      const maxRetries = 3
      
      const createSubscription = async (): Promise<number> => {
        try {
          console.log(`🔧 Creating subscription attempt ${retryCount + 1}...`)
          
          const id = activeConnection.onLogs(
            TOKEN_PROGRAM_ID,
            (logs: any, context: any) => {
              try {
                // Add safety check to prevent errors during processing
                if (isMountedRef.current) {
                  console.log('📨 Received onLogs event:', logs.signature.slice(0, 8))
                  processNewToken(logs, context)
                }
              } catch (error) {
                console.error('Error in processNewToken:', error)
                // Don't let errors bubble up to React
              }
            },
            'confirmed'
          )
          
          console.log(`✅ Subscription created successfully with ID: ${id}`)
          return id
        } catch (error: any) {
          console.warn(`🔧 WebSocket subscription attempt ${retryCount + 1} failed:`, error.message)
          
          if (retryCount < maxRetries) {
            retryCount++
            console.log(`� Retrying WebSocket subscription in ${retryCount * 2}s... (${retryCount}/${maxRetries})`)
            await new Promise(resolve => setTimeout(resolve, retryCount * 2000))
            return createSubscription()
          } else {
            throw new Error(`Failed to create WebSocket subscription after ${maxRetries} attempts: ${error.message}`)
          }
        }
      }

      const id = await createSubscription()
      
      // Track the subscription
      HeliusConnection.addSubscription(id)
      setSubscriptionId(id)
      setIsConnected(true)
      console.log('✅ onLogs monitoring started - ID:', id)
      console.log('🎯 Listening for InitializeMint transactions')
      console.log('📊 This method is more precise than account changes')
      
      // Test subscription immediately
      setTimeout(() => {
        console.log('🔍 Testing subscription health after 5 seconds...')
        console.log(`📊 Current accountsProcessed: ${accountsProcessed}`)
        console.log(`🔗 Subscription ID: ${id}`)
        console.log(`📡 Connection active: ${activeConnection ? 'Yes' : 'No'}`)
      }, 5000)
      
      // Heartbeat every 30 seconds
      const heartbeatInterval = setInterval(() => {
        // Only update state if component is still mounted
        if (!isMountedRef.current) return
        
        const timestamp = Date.now()
        
        setHeartbeatCount(prev => {
          const newCount = prev + 1
          console.log(`💓 Heartbeat #${newCount} - Subscription ID: ${id}`)
          return newCount
        })
        setLastHeartbeat(timestamp)
        
        // Simple heartbeat log without accessing other state
        console.log(`💓 Heartbeat: ${new Date().toLocaleTimeString()}`)
      }, 30000)

      // Light polling every 5 minutes (reduced from 2 min to avoid Helius rate limits)
      const pollingInterval = setInterval(() => {
        pollForNewMints()
      }, 300000)

      // Connection health check every 5 minutes (increased to reduce load)
      const healthCheckInterval = setInterval(async () => {
        if (!isMountedRef.current) return
        
        try {
          // Use configuration check first, then optional RPC test
          const configValid = HeliusConnection.validateConfiguration()
          if (!configValid) {
            console.warn('⚠️ Health check: Configuration issues detected')
            if (isMountedRef.current) setIsConnected(false)
            return
          }
          
          // Optional RPC test - don't fail if it errors
          try {
            const testConnection = await HeliusConnection.lightConnectionTest()
            if (isMountedRef.current) {
              if (testConnection && !isConnected) {
                console.log('✅ Health check: Connection restored')
                setIsConnected(true)
              } else if (!testConnection && isConnected) {
                console.warn('⚠️ Health check: Connection may be degraded')
                // Don't immediately mark as disconnected, give it some time
              }
            }
          } catch (rpcError) {
            // Silent RPC errors during health check
            // Connection status will be updated by actual usage
          }
        } catch (error) {
          // Silent overall health check errors
        }
      }, 300000) // Check every 5 minutes instead of 2

      setIntervals({ 
        heartbeat: heartbeatInterval, 
        polling: pollingInterval,
        healthCheck: healthCheckInterval
      })
      
      // Initial setup
      setHeartbeatCount(1)
      setLastHeartbeat(Date.now())
      // Removed initial pollForNewMints() call to reduce RPC usage
      
      // Start market checking immediately if there are tokens in queue
      setMarketCheckQueue(currentQueue => {
        if (currentQueue.size > 0) {
          console.log('🚀 Starting immediate market check for existing tokens...')
          setTimeout(() => {
            try {
              if (isMountedRef.current) {
                processMarketCheckQueue()
              }
            } catch (error) {
              console.warn('Error in initial market check:', error)
            }
          }, 2000) // Small delay to let things settle
        }
        return currentQueue // Don't change queue, just inspect
      })
      
    } catch (error) {
      console.error('❌ Failed to start monitoring:', error)
      // Safely update state even if there was an error
      if (isMountedRef.current) {
        setIsConnected(false)
      }
    }
  }, [isMonitoring, connection]) // Added isMonitoring back to dependencies

  const stopMonitoring = useCallback(async () => {
    // Use state callback to get current subscription ID and check if we should stop
    let currentSubscriptionId: number | null = null
    let shouldStop = false
    
    setSubscriptionId(prev => {
      if (!prev) {
        console.log('🛑 No subscription to stop')
        return prev
      }
      currentSubscriptionId = prev
      shouldStop = true
      return prev
    })
    
    if (!shouldStop || !currentSubscriptionId) return

    console.log(`🛑 Stopping monitoring for subscription ID: ${currentSubscriptionId}`)

    // Use the same connection type for cleanup
    const activeConnection = connection || HeliusConnection.getWebSocketConnection()

    try {
      // Clear intervals first
      setIntervals(currentIntervals => {
        if (currentIntervals.heartbeat) {
          clearInterval(currentIntervals.heartbeat)
          console.log('⏹️ Cleared heartbeat interval')
        }
        if (currentIntervals.polling) {
          clearInterval(currentIntervals.polling)
          console.log('⏹️ Cleared polling interval')
        }
        if (currentIntervals.marketCheck) {
          clearInterval(currentIntervals.marketCheck)
          console.log('⏹️ Cleared market check interval')
        }
        if (currentIntervals.healthCheck) {
          clearInterval(currentIntervals.healthCheck)
          console.log('⏹️ Cleared health check interval')
        }
        return {} // Clear all intervals
      })
      
      // Remove logs subscription with error handling
      try {
        await HeliusConnection.safeRemoveSubscription(currentSubscriptionId)
        console.log('✅ WebSocket subscription removed successfully')
      } catch (error: any) {
        // Error already handled in safeRemoveSubscription
        console.log('ℹ️ Subscription cleanup completed (may have been auto-removed)')
      }
      
      // Reset state
      setSubscriptionId(null)
      setIsConnected(false)
      setHeartbeatCount(0)
      setLastHeartbeat(0)
      setAccountsProcessed(0)
      setPollingResults(0)
      
      console.log('🛑 onLogs monitoring stopped completely')
    } catch (error) {
      console.error('Error stopping monitoring:', error)
      // Force reset state even if there was an error
      setSubscriptionId(null)
      setIsConnected(false)
    }
  }, [connection]) // Minimized dependencies - removed subscriptionId and intervals

  useEffect(() => {
    isMountedRef.current = true // Ensure we're mounted
    
    console.log('🔧 useEffect triggered - isMonitoring:', isMonitoring)
    
    if (isMonitoring) {
      console.log('🚀 Starting monitoring...')
      startMonitoring()
    } else {
      console.log('🛑 Stopping monitoring...')
      stopMonitoring()
    }

    return () => {
      // Mark as unmounted to prevent state updates
      isMountedRef.current = false
    }
  }, [isMonitoring, startMonitoring, stopMonitoring])

  // Cleanup effect on unmount
  useEffect(() => {
    return () => {
      // Cleanup on unmount using state callbacks to avoid dependencies
      setIntervals(currentIntervals => {
        if (currentIntervals.heartbeat) clearInterval(currentIntervals.heartbeat)
        if (currentIntervals.polling) clearInterval(currentIntervals.polling)
        if (currentIntervals.marketCheck) clearInterval(currentIntervals.marketCheck)
        if (currentIntervals.healthCheck) clearInterval(currentIntervals.healthCheck)
        return {}
      })
      
      setSubscriptionId(currentId => {
        if (currentId) {
          try {
            HeliusConnection.safeRemoveSubscription(currentId)
            console.log('🧹 Cleaned up subscription on unmount')
          } catch (error) {
            console.warn('⚠️ Error removing subscription on unmount:', error)
          }
        }
        return null
      })
    }
  }, []) // Only run on unmount

  // Separate useEffect for market check interval to avoid dependency issues
  useEffect(() => {
    if (!isMonitoring) {
      console.log('🔧 Market check interval not needed (monitoring stopped)')
      return
    }

    console.log('🔧 Setting up market check interval (every 120 seconds to avoid rate limits)...')
    
    const marketCheckInterval = setInterval(() => {
      console.log(`⏰ Market check interval triggered!`)
      processMarketCheckQueue()
    }, 120000) // 2 minutes

    // Store the interval for cleanup
    setIntervals(prev => ({
      ...prev,
      marketCheck: marketCheckInterval
    }))

    return () => {
      console.log('🔧 Cleaning up market check interval...')
      clearInterval(marketCheckInterval)
    }
  }, [isMonitoring, processMarketCheckQueue])

  // Backoff recovery effect - gradually reduce backoff over time
  useEffect(() => {
    if (rateLimitBackoff <= 0) return

    const backoffRecoveryInterval = setInterval(() => {
      setRateLimitBackoff(prev => {
        const newBackoff = Math.max(0, prev - 1)
        if (newBackoff === 0) {
          console.log('✅ Rate limit backoff cleared - resuming normal operation')
        } else {
          console.log(`⏱️ Rate limit backoff reduced to level ${newBackoff}`)
        }
        return newBackoff
      })
    }, 60000) // Reduce backoff level every minute

    return () => clearInterval(backoffRecoveryInterval)
  }, [rateLimitBackoff])

  const clearDetectedTokens = useCallback(() => {
    setDetectedTokens([])
  }, [])

  const removeToken = useCallback((mint: string) => {
    setDetectedTokens(prev => prev.filter(token => token.mint !== mint))
    // Also remove from market check queue
    setMarketCheckQueue(prev => {
      const newQueue = new Set(prev)
      newQueue.delete(mint)
      return newQueue
    })
  }, [])

  // Move token to sniped list
  const markTokenAsSniped = useCallback((mint: string, snipeData?: { 
    amount?: number; 
    price?: number; 
    signature?: string 
  }) => {
    const tokenToSnipe = detectedTokens.find(token => token.mint === mint)
    if (!tokenToSnipe) return

    const snipedToken: SnipedToken = {
      ...tokenToSnipe,
      snipedAt: Date.now(),
      snipeAmount: snipeData?.amount,
      snipePrice: snipeData?.price,
      snipeSignature: snipeData?.signature
    }

    // Add to sniped tokens
    setSnipedTokens(prev => [snipedToken, ...prev].slice(0, 50)) // Keep max 50 sniped tokens
    
    // Remove from detected tokens
    removeToken(mint)
    
    console.log('✅ Token marked as sniped:', mint.slice(0, 8))
  }, [detectedTokens, removeToken])

  const clearSnipedTokens = useCallback(() => {
    setSnipedTokens([])
  }, [])

  const removeSnipedToken = useCallback((mint: string) => {
    setSnipedTokens(prev => prev.filter(token => token.mint !== mint))
  }, [])

  // Manual market check function for UI
  const performManualMarketCheck = useCallback(async (mintAddress: string) => {
    console.log(`🔍 Manual market check for: ${mintAddress.slice(0, 8)}...`)
    
    // Update status to checking
    setDetectedTokens(prev => prev.map(token => 
      token.mint === mintAddress 
        ? { ...token, marketStatus: 'checking' as const }
        : token
    ))
    
    try {
      const marketStatus = await checkTokenMarket(mintAddress)
      
      // Update token with result
      setDetectedTokens(prev => prev.map(token => {
        if (token.mint === mintAddress) {
          return {
            ...token,
            marketStatus,
            lastMarketCheck: Date.now(),
            marketCheckCount: (token.marketCheckCount || 0) + 1
          }
        }
        return token
      }))
      
      return marketStatus
    } catch (error) {
      console.error('Manual market check failed:', error)
      
      // Update token with error status
      setDetectedTokens(prev => prev.map(token => 
        token.mint === mintAddress 
          ? { 
              ...token, 
              marketStatus: 'error' as const,
              lastMarketCheck: Date.now(),
              marketCheckCount: (token.marketCheckCount || 0) + 1
            }
          : token
      ))
      
      return 'error' as const
    }
  }, [checkTokenMarket])

  // Debug function to force market check queue processing
  const debugForceMarketCheck = useCallback(() => {
    console.log('🔧 DEBUG: Force triggering market check queue...')
    processMarketCheckQueue()
  }, [processMarketCheckQueue])

  // Function to manually reset rate limit backoff
  const resetRateLimitBackoff = useCallback(() => {
    console.log('🔧 Manually resetting rate limit backoff...')
    setRateLimitBackoff(0)
  }, [])

  return {
    detectedTokens,
    snipedTokens,
    isConnected,
    isMonitoring: Boolean(subscriptionId),
    heartbeatCount,
    lastHeartbeat,
    accountsProcessed,
    pollingResults,
    marketCheckQueue: marketCheckQueue.size,
    rateLimitBackoff,
    clearDetectedTokens,
    removeToken,
    markTokenAsSniped,
    clearSnipedTokens,
    removeSnipedToken,
    checkTokenMarket: performManualMarketCheck,
    debugForceMarketCheck, // Add debug function
    resetRateLimitBackoff // Expose reset function
  }
}