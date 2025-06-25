'use client'

import { useEffect, useState, useCallback } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import HeliusConnection from '../services/HeliusConnection'

export interface NewToken {
  mint: string
  timestamp: number
  signature: string
  creator?: string
  name?: string
  symbol?: string
  supply?: number
}

export const useMintDetection = (connection: Connection | null, isMonitoring: boolean) => {
  const [detectedTokens, setDetectedTokens] = useState<NewToken[]>([])
  const [subscriptionId, setSubscriptionId] = useState<number | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [heartbeatCount, setHeartbeatCount] = useState(0)
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(0)
  const [accountsProcessed, setAccountsProcessed] = useState(0)
  const [pollingResults, setPollingResults] = useState(0)
  const [intervals, setIntervals] = useState<{ heartbeat?: NodeJS.Timeout; polling?: NodeJS.Timeout }>({})

  const processNewToken = useCallback(async (logs: any, context: any) => {
    try {
      // Count transaction log events
      setAccountsProcessed(prev => prev + 1)
      
      // Check if this transaction contains InitializeMint
      const hasInit = logs.logs.find((l: string) => l.includes("InitializeMint"))
      if (!hasInit) return

      console.log('🔔 InitializeMint detected in slot', logs.slot)
      console.log('  Signature:', logs.signature)

      try {
        const activeConnection = connection || HeliusConnection.getRpcConnection()
        
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
          supply: 0
        }

        console.log('🔄 Adding token to state:', newToken)
        
        setDetectedTokens(prev => {
          console.log('📊 Current tokens in state:', prev.length)
          const isDuplicate = prev.some(token => token.mint === mintAddress)
          if (isDuplicate) {
            console.log('⚠️ Duplicate token detected, skipping:', mintAddress)
            return prev
          }
          
          console.log('🎉 NEW TOKEN ADDED TO STATE:', mintAddress)
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
  }, [connection])

  // Light polling backup method
  const pollForNewMints = useCallback(async () => {
    try {
      const activeConnection = connection || HeliusConnection.getRpcConnection()
      
      // Check recent signatures (light method)
      try {
        const signatures = await activeConnection.getSignaturesForAddress(
          TOKEN_PROGRAM_ID,
          { limit: 5 }
        )
        
        setPollingResults(signatures.length)
        
      } catch (error) {
        setPollingResults(prev => prev + 1) // Just show activity
      }
      
    } catch (error) {
      // Silent polling errors
    }
  }, [connection])

  const startMonitoring = useCallback(async () => {
    if (!isMonitoring || subscriptionId) return

    const activeConnection = connection || HeliusConnection.getRpcConnection()

    try {
      console.log('🔍 Starting mint detection with onLogs...')
      
      // Test connection
      const connectionTest = await HeliusConnection.testConnection()
      if (!connectionTest) {
        throw new Error('Connection test failed')
      }

      // Setup transaction logs listener (more precise than account changes)
      console.log('📡 Setting up onLogs listener for InitializeMint...')
      const id = activeConnection.onLogs(
        TOKEN_PROGRAM_ID,
        (logs: any, context: any) => {
          try {
            processNewToken(logs, context)
          } catch (error) {
            console.error('Error in processNewToken:', error)
          }
        },
        'confirmed'
      )

      setSubscriptionId(id)
      setIsConnected(true)
      console.log('✅ onLogs monitoring started - ID:', id)
      console.log('🎯 Listening for InitializeMint transactions')
      console.log('📊 This method is more precise than account changes')
      
      // Heartbeat every 30 seconds
      const heartbeatInterval = setInterval(() => {
        setHeartbeatCount(prev => {
          const newCount = prev + 1
          setLastHeartbeat(Date.now())
          
          setAccountsProcessed(currentCount => {
            setPollingResults(currentPollingResults => {
              console.log(`💓 Heartbeat #${newCount} - ${currentCount} transactions, ${currentPollingResults} activity`)
              return currentPollingResults
            })
            return currentCount
          })
          
          return newCount
        })
      }, 30000)

      // Light polling every 2 minutes
      const pollingInterval = setInterval(() => {
        pollForNewMints()
      }, 120000)

      setIntervals({ heartbeat: heartbeatInterval, polling: pollingInterval })
      
      // Initial setup
      setHeartbeatCount(1)
      setLastHeartbeat(Date.now())
      pollForNewMints()
      
    } catch (error) {
      console.error('❌ Failed to start monitoring:', error)
      setIsConnected(false)
    }
  }, [isMonitoring, subscriptionId, processNewToken, connection, pollForNewMints])

  const stopMonitoring = useCallback(async () => {
    if (!subscriptionId) return

    const activeConnection = connection || HeliusConnection.getRpcConnection()

    try {
      // Clear intervals
      if (intervals.heartbeat) clearInterval(intervals.heartbeat)
      if (intervals.polling) clearInterval(intervals.polling)
      setIntervals({})
      
      // Remove logs subscription
      activeConnection.removeOnLogsListener(subscriptionId)
      
      // Reset state
      setSubscriptionId(null)
      setIsConnected(false)
      setHeartbeatCount(0)
      setLastHeartbeat(0)
      setAccountsProcessed(0)
      setPollingResults(0)
      
      console.log('🛑 onLogs monitoring stopped')
    } catch (error) {
      console.error('Error stopping monitoring:', error)
    }
  }, [subscriptionId, connection, intervals])

  useEffect(() => {
    if (isMonitoring) {
      startMonitoring()
    } else {
      stopMonitoring()
    }

    return () => {
      // Cleanup on unmount
      if (intervals.heartbeat) clearInterval(intervals.heartbeat)
      if (intervals.polling) clearInterval(intervals.polling)
      if (subscriptionId) {
        const activeConnection = connection || HeliusConnection.getRpcConnection()
        activeConnection.removeOnLogsListener(subscriptionId)
      }
    }
  }, [isMonitoring, startMonitoring, stopMonitoring])

  const clearDetectedTokens = useCallback(() => {
    setDetectedTokens([])
  }, [])

  const removeToken = useCallback((mint: string) => {
    setDetectedTokens(prev => prev.filter(token => token.mint !== mint))
  }, [])

  return {
    detectedTokens,
    isConnected,
    isMonitoring: Boolean(subscriptionId),
    heartbeatCount,
    lastHeartbeat,
    accountsProcessed,
    pollingResults,
    clearDetectedTokens,
    removeToken
  }
}