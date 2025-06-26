'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createJupiterApiClient } from '@jup-ag/api'

interface TrackedToken {
  mint: string
  name?: string
  symbol?: string
  purchasePrice: number // Price in SOL when purchased
  purchaseAmount: number // Amount of tokens purchased
  purchaseTimestamp: number
  currentPrice: number // Current price in SOL
  lastPriceUpdate: number
  priceChange24h?: number
  isLoading?: boolean
  error?: string
}

interface PriceTrackerProps {
  className?: string
}

export default function PriceTracker({ className = '' }: PriceTrackerProps) {
  const [trackedTokens, setTrackedTokens] = useState<TrackedToken[]>([])
  const [isUpdatingPrices, setIsUpdatingPrices] = useState(false)
  const [lastUpdateTime, setLastUpdateTime] = useState<number>(0)
  const [updateInterval, setUpdateInterval] = useState<NodeJS.Timeout | null>(null)
  
  // Use a ref to avoid dependency issues in useEffect
  const trackedTokensRef = useRef<TrackedToken[]>([])
  
  // Update ref whenever trackedTokens changes
  useEffect(() => {
    trackedTokensRef.current = trackedTokens
  }, [trackedTokens])

  // Jupiter API client
  const jupiterApi = createJupiterApiClient()
  const SOL_MINT = 'So11111111111111111111111111111111111111112'

  // Load tracked tokens from localStorage
  const loadTrackedTokens = useCallback((): TrackedToken[] => {
    if (typeof window === 'undefined') return []
    try {
      const stored = localStorage.getItem('solsniperbot_tracked_tokens')
      return stored ? JSON.parse(stored) : []
    } catch (error) {
      console.warn('Failed to load tracked tokens:', error)
      return []
    }
  }, [])

  // Save tracked tokens to localStorage
  const saveTrackedTokens = useCallback((tokens: TrackedToken[]) => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem('solsniperbot_tracked_tokens', JSON.stringify(tokens))
    } catch (error) {
      console.warn('Failed to save tracked tokens:', error)
    }
  }, [])

  // Get current price for a token with retry mechanism
  const getCurrentPrice = useCallback(async (mintAddress: string, retryCount = 0): Promise<number | null> => {
    const maxRetries = 2
    
    try {
      // Add progressive delay to avoid rate limiting - increased delays
      const delay = (retryCount + 1) * 1000 // 1s, 2s, 3s delays
      await new Promise(resolve => setTimeout(resolve, delay))
      
      // Try to get a quote from token to SOL
      const quote = await jupiterApi.quoteGet({
        inputMint: mintAddress,
        outputMint: SOL_MINT,
        amount: 1000000, // 1 million base units of the token
        slippageBps: 5000 // 50% max slippage for very new tokens
      })

      if (quote && quote.outAmount) {
        // Calculate price per token in SOL
        const solReceived = parseInt(quote.outAmount) / 1e9 // Convert lamports to SOL
        const pricePerToken = solReceived / 1 // Price per 1 million tokens in SOL
        return pricePerToken * 1000000 // Price per single token
      }

      return null
    } catch (error: unknown) {
      // Handle specific error types
      const errorMessage = error instanceof Error ? error.message : (typeof error === 'string' ? error : 'Unknown error')
      
      if (errorMessage.includes('429') || errorMessage.includes('rate limit') || errorMessage.includes('Rate limit')) {
        if (retryCount < maxRetries) {
          console.log(`⏱️ Rate limited for token ${mintAddress.slice(0, 8)}, retrying in ${(retryCount + 2) * 2}s... (${retryCount + 1}/${maxRetries})`)
          await new Promise(resolve => setTimeout(resolve, (retryCount + 2) * 2000)) // Progressive backoff
          return getCurrentPrice(mintAddress, retryCount + 1)
        }
        return null
      } else if (errorMessage.includes('400') || errorMessage.includes('Bad Request')) {
        // Token likely not tradeable - don't retry or spam logs
        return null
      } else if (errorMessage.includes('No routes found') || errorMessage.includes('No route found')) {
        // No trading routes available - normal for new tokens
        return null
      } else {
        // Retry unexpected errors once
        if (retryCount < 1) {
          console.log(`🔄 Retrying price fetch for ${mintAddress.slice(0, 8)} due to: ${errorMessage}`)
          await new Promise(resolve => setTimeout(resolve, 2000))
          return getCurrentPrice(mintAddress, retryCount + 1)
        }
        return null
      }
    }
  }, [jupiterApi])

  // Update prices for all tracked tokens with sequential processing
  const updateAllPrices = useCallback(async () => {
    const currentTokens = trackedTokensRef.current
    if (currentTokens.length === 0) return

    console.log(`🔄 Updating prices for ${currentTokens.length} tracked tokens sequentially...`)
    setIsUpdatingPrices(true)

    const updatedTokens: TrackedToken[] = []
    
    // Process tokens sequentially to avoid rate limiting
    for (let i = 0; i < currentTokens.length; i++) {
      const token = currentTokens[i]
      
      try {
        console.log(`📊 Fetching price for ${token.name || token.mint.slice(0, 8)} (${i + 1}/${currentTokens.length})`)
        
        const currentPrice = await getCurrentPrice(token.mint)
        
        if (currentPrice !== null) {
          updatedTokens.push({
            ...token,
            currentPrice,
            lastPriceUpdate: Date.now(),
            isLoading: false,
            error: undefined
          })
        } else {
          updatedTokens.push({
            ...token,
            isLoading: false,
            error: 'Price unavailable'
          })
        }
      } catch {
        updatedTokens.push({
          ...token,
          isLoading: false,
          error: 'Price fetch failed'
        })
      }
      
      // Add delay between requests to avoid overwhelming the API
      if (i < currentTokens.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000)) // Increased to 2 seconds delay between tokens
      }
    }

    setTrackedTokens(updatedTokens)
    saveTrackedTokens(updatedTokens)
    setLastUpdateTime(Date.now())
    setIsUpdatingPrices(false)

    console.log('✅ Price update completed')
  }, [getCurrentPrice, saveTrackedTokens]) // Removed trackedTokens dependency

  // Add a new token to track
  // const addTokenToTrack = useCallback((
  //   mint: string,
  //   name: string,
  //   symbol: string,
  //   purchasePrice: number,
  //   purchaseAmount: number
  // ) => {
  //   const newToken: TrackedToken = {
  //     mint,
  //     name,
  //     symbol,
  //     purchasePrice,
  //     purchaseAmount,
  //     purchaseTimestamp: Date.now(),
  //     currentPrice: purchasePrice, // Start with purchase price
  //     lastPriceUpdate: Date.now(),
  //     isLoading: false
  //   }

  //   setTrackedTokens(prev => {
  //     const updated = [newToken, ...prev]
  //     saveTrackedTokens(updated)
  //     return updated
  //   })

  //   console.log(`📊 Added token to price tracking: ${name} (${symbol})`)
  // }, [saveTrackedTokens])

  // Remove token from tracking
  const removeTokenFromTracking = useCallback((mint: string) => {
    setTrackedTokens(prev => {
      const updated = prev.filter(token => token.mint !== mint)
      saveTrackedTokens(updated)
      return updated
    })
  }, [saveTrackedTokens])

  // Calculate profit/loss
  const calculatePnL = useCallback((token: TrackedToken) => {
    const currentValue = token.currentPrice * token.purchaseAmount
    const purchaseValue = token.purchasePrice * token.purchaseAmount
    const pnl = currentValue - purchaseValue
    const pnlPercentage = ((currentValue - purchaseValue) / purchaseValue) * 100

    return {
      pnl,
      pnlPercentage,
      currentValue,
      purchaseValue
    }
  }, [])

  // Format time ago
  const formatTimeAgo = useCallback((timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return 'Just now'
  }, [])

  // Load tokens on mount (only once)
  useEffect(() => {
    const tokens = loadTrackedTokens()
    setTrackedTokens(tokens)
    
    if (tokens.length > 0) {
      // Update prices immediately with a longer delay to avoid rate limits
      setTimeout(() => {
        updateAllPrices()
      }, 3000) // Increased to 3 seconds
    }
  }, [loadTrackedTokens, updateAllPrices]) // Add dependencies to fix ESLint warning

  // Set up price update interval with longer delay
  useEffect(() => {
    if (trackedTokens.length === 0) {
      if (updateInterval) {
        clearInterval(updateInterval)
        setUpdateInterval(null)
      }
      return
    }

    // Clear existing interval before setting a new one
    if (updateInterval) {
      clearInterval(updateInterval)
    }

    console.log('🔧 Setting up price update interval (every 5 minutes to avoid rate limits)...')
    
    const interval = setInterval(() => {
      updateAllPrices()
    }, 300000) // Update every 5 minutes (300 seconds) to be extra safe

    setUpdateInterval(interval)

    return () => {
      if (interval) {
        clearInterval(interval)
      }
    }
  }, [trackedTokens.length, updateAllPrices]) // Add updateAllPrices dependency

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (updateInterval) {
        clearInterval(updateInterval)
      }
    }
  }, [updateInterval])

  if (trackedTokens.length === 0) {
    return (
      <div className={`bg-gray-800/50 rounded-xl p-6 ${className}`}>
        <div className="text-center text-gray-400">
          <div className="text-4xl mb-4">📊</div>
          <h3 className="text-lg font-medium mb-2">No Tokens Being Tracked</h3>
          <p className="text-sm">
            Tokens you purchase will automatically appear here for price tracking.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`bg-gray-800/50 rounded-xl p-6 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center">
          <h2 className="text-xl font-bold text-white mr-3">Price Tracker</h2>
          <span className="text-sm text-gray-400">({trackedTokens.length} tokens)</span>
          <span className="ml-2 px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded">
            5min updates
          </span>
        </div>
        
        <div className="flex items-center gap-3">
          {lastUpdateTime > 0 && (
            <span className="text-xs text-gray-400">
              Last update: {formatTimeAgo(lastUpdateTime)}
            </span>
          )}
          
          <button
            onClick={updateAllPrices}
            disabled={isUpdatingPrices}
            className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isUpdatingPrices ? '🔄 Updating...' : '🔄 Refresh Prices'}
          </button>
        </div>
      </div>

      {/* Tokens List */}
      <div className="space-y-4">
        {trackedTokens.map((token) => {
          const pnl = calculatePnL(token)
          const isProfit = pnl.pnl >= 0

          return (
            <div key={token.mint} className="bg-gray-700/30 rounded-lg p-4 border border-gray-600/20">
              <div className="flex items-center justify-between">
                {/* Token Info */}
                <div className="flex-1">
                  <div className="flex items-center mb-2">
                    <h3 className="font-medium text-white mr-2">
                      {token.name || `Token-${token.mint.slice(0, 8)}`}
                    </h3>
                    <span className="px-2 py-1 bg-gray-600/50 text-gray-300 text-xs rounded">
                      {token.symbol || 'UNK'}
                    </span>
                  </div>
                  
                  <div className="text-xs text-gray-400 mb-3">
                    {token.mint.slice(0, 8)}...{token.mint.slice(-8)}
                  </div>

                  {/* Purchase Info */}
                  <div className="grid grid-cols-2 gap-4 text-sm mb-3">
                    <div>
                      <span className="text-gray-400">Purchase Price:</span>
                      <div className="text-white font-mono">
                        {token.purchasePrice.toFixed(8)} SOL
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-400">Amount:</span>
                      <div className="text-white font-mono">
                        {token.purchaseAmount.toLocaleString()}
                      </div>
                    </div>
                  </div>

                  {/* Current Price & P&L */}
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-400">Current Price:</span>
                      <div className="text-white font-mono">
                        {token.isLoading ? (
                          <span className="text-blue-400">Loading...</span>
                        ) : token.error ? (
                          <span className="text-red-400">{token.error}</span>
                        ) : (
                          `${token.currentPrice.toFixed(8)} SOL`
                        )}
                      </div>
                    </div>
                    <div>
                      <span className="text-gray-400">P&L:</span>
                      <div className={`font-mono ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
                        {isProfit ? '+' : ''}{pnl.pnl.toFixed(4)} SOL
                        <span className="text-xs ml-1">
                          ({isProfit ? '+' : ''}{pnl.pnlPercentage.toFixed(1)}%)
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col items-end gap-2">
                  <div className="text-xs text-gray-400">
                    {formatTimeAgo(token.purchaseTimestamp)}
                  </div>
                  
                  <button
                    onClick={() => removeTokenFromTracking(token.mint)}
                    className="px-3 py-1 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded text-xs transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Price Update Status */}
      {isUpdatingPrices && (
        <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <div className="flex items-center justify-between text-blue-400">
            <div className="flex items-center">
              <div className="animate-spin w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full mr-2"></div>
              <span className="text-sm">Updating prices sequentially...</span>
            </div>
            <div className="text-xs text-blue-300">
              Rate-limited to avoid API errors
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Export the addTokenToTrack function for use in other components
export { type TrackedToken }
