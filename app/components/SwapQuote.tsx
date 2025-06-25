'use client'

import React, { useState, useEffect } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { useJupiterSwap } from '../hooks/useJupiterSwap'

interface SwapQuoteProps {
  tokenAddress: string
  amount: string
  slippage: string
  onSwapSuccess?: (signature: string) => void
}

const SOL_MINT = 'So11111111111111111111111111111111111111112'

const SwapQuote: React.FC<SwapQuoteProps> = ({ 
  tokenAddress, 
  amount, 
  slippage,
  onSwapSuccess 
}) => {
  const { connection } = useConnection()
  const { publicKey, signTransaction } = useWallet()
  const { swapRoute, getSwapQuote, prepareSwapTransaction, executeSwap, clearRoute, isTokenTradeable } = useJupiterSwap(connection)
  const [isExecuting, setIsExecuting] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [lastQuoteTime, setLastQuoteTime] = useState<number>(0)
  const [quoteAge, setQuoteAge] = useState<number>(0)
  const [hasInitialQuote, setHasInitialQuote] = useState(false)
  const [lastParams, setLastParams] = useState<string>('')

  // Track parameter changes and manage quote fetching
  useEffect(() => {
    const currentParams = `${tokenAddress}-${amount}-${slippage}`
    
    // If parameters are invalid, clear everything
    if (!tokenAddress || !amount || parseFloat(amount) <= 0) {
      if (lastParams !== '') {
        // Defer state updates to avoid React warnings
        setTimeout(() => {
          clearRoute()
          setLastQuoteTime(0)
          setHasInitialQuote(false)
          setLastParams('')
        }, 0)
      }
      return
    }

    // If parameters changed, reset and potentially fetch new quote
    if (currentParams !== lastParams) {
      setLastParams(currentParams)
      setHasInitialQuote(false)
      setLastQuoteTime(0)
      
      // Clear existing quote when parameters change
      setTimeout(() => {
        clearRoute()
      }, 0)
    }
  }, [tokenAddress, amount, slippage, lastParams, clearRoute])

  // Update quote age every second (but don't auto-refresh)
  useEffect(() => {
    if (!lastQuoteTime) return

    const updateAge = () => {
      setQuoteAge(Date.now() - lastQuoteTime)
    }

    updateAge() // Initial update
    const ageInterval = setInterval(updateAge, 1000)
    
    return () => clearInterval(ageInterval)
  }, [lastQuoteTime])

  const handleSwap = async () => {
    if (!swapRoute.quote || !publicKey || !signTransaction) return

    setIsExecuting(true)
    try {
      // Prepare transaction
      const transaction = await prepareSwapTransaction(swapRoute.quote, publicKey)
      if (!transaction) {
        throw new Error('Failed to prepare transaction')
      }

      // Execute swap
      const signature = await executeSwap(transaction, { signTransaction })
      
      if (onSwapSuccess) {
        onSwapSuccess(signature)
      }

      console.log('🎉 Swap completed successfully!')
    } catch (error) {
      console.error('Swap failed:', error)
      alert(`Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setIsExecuting(false)
    }
  }

  const refreshQuote = async () => {
    if (swapRoute.loading) return
    
    try {
      const slippageBps = Math.floor(parseFloat(slippage) * 100)
      await getSwapQuote(SOL_MINT, tokenAddress, parseFloat(amount), slippageBps)
      setLastQuoteTime(Date.now())
    } catch (error) {
      console.log('Error refreshing quote:', error)
    }
  }

  const formatQuoteAge = (ageMs: number) => {
    const seconds = Math.floor(ageMs / 1000)
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m ${seconds % 60}s ago`
  }

  const formatNumber = (num: string | number, decimals = 6) => {
    const value = typeof num === 'string' ? parseFloat(num) : num
    return value.toLocaleString(undefined, { 
      minimumFractionDigits: 0, 
      maximumFractionDigits: decimals 
    })
  }

  const formatTokenAmount = (amount: string, decimals = 9) => {
    const value = parseInt(amount) / Math.pow(10, decimals)
    return formatNumber(value)
  }

  if (!tokenAddress || !amount || parseFloat(amount) <= 0) {
    return (
      <div className="mt-4 p-4 bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/20 rounded-lg">
        <div className="text-center text-gray-400">
          💰 Enter a token address and amount to get swap quotes
        </div>
      </div>
    )
  }

  return (
    <div className="mt-4 p-4 bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/20 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-lg font-semibold text-white flex items-center">
          🔄 Jupiter Swap Quote
          {lastQuoteTime > 0 && !swapRoute.loading && (
            <span className="ml-2 text-xs text-gray-400">
              ({formatQuoteAge(quoteAge)})
            </span>
          )}
        </h4>
        <div className="flex items-center space-x-2">
          {(swapRoute.loading || isValidating) && (
            <div className="flex items-center text-sm text-gray-400">
              <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mr-2"></div>
              {isValidating ? 'Validating...' : 'Loading...'}
            </div>
          )}

          {/* Manual refresh - always available */}
          <button
            onClick={refreshQuote}
            disabled={swapRoute.loading || isValidating}
            className="px-3 py-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 rounded text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Get fresh quote"
            data-testid="swap-quote-refresh"
          >
            🔄 Refresh Quote
          </button>
        </div>
      </div>

      {swapRoute.error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="text-red-400 text-sm">
            ❌ {swapRoute.error}
          </div>
          {swapRoute.error.includes('Jupiter API') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Try again in a few seconds. Jupiter API may be experiencing high load.
            </div>
          )}
          {swapRoute.error.includes('Network error') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Check your internet connection and try again.
            </div>
          )}
          {swapRoute.error.includes('timeout') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Request took too long. The API may be slow right now.
            </div>
          )}
          {swapRoute.error.includes('not tradeable') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 This token might be very new or not have enough liquidity yet. Try a different token or wait a bit.
            </div>
          )}
          {swapRoute.error.includes('pair does not exist') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 No trading route found for this token. It may not be listed on major DEXs yet.
            </div>
          )}
          {swapRoute.error.includes('Invalid token address') && (
            <div className="mt-2 text-xs text-gray-400">
              💡 Please check that the token address is valid and correctly formatted.
            </div>
          )}
        </div>
      )}

      {/* No quote yet - show get quote prompt */}
      {!swapRoute.quote && !swapRoute.loading && !swapRoute.error && tokenAddress && amount && parseFloat(amount) > 0 && (
        <div className="text-center py-6 border-2 border-dashed border-gray-500/30 rounded-lg">
          <div className="text-gray-400 mb-3">
            💱 Ready to get a swap quote for this token?
          </div>
          <button
            onClick={refreshQuote}
            className="px-4 py-2 bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 rounded-lg font-medium transition-colors"
            data-testid="get-swap-quote"
          >
            🔄 Get Swap Quote
          </button>
          <div className="mt-2 text-xs text-gray-400">
            Quotes are fetched manually for better control
          </div>
        </div>
      )}

      {swapRoute.quote && !swapRoute.loading && (
        <div className="space-y-3">
          {/* Quote freshness indicator */}
          {lastQuoteTime > 0 && (
            <div className={`flex items-center justify-between p-2 rounded-lg text-xs ${
              quoteAge < 15000 ? 'bg-green-500/10 border border-green-500/20' :
              quoteAge < 30000 ? 'bg-yellow-500/10 border border-yellow-500/20' :
              'bg-red-500/10 border border-red-500/20'
            }`}>
              <div className="flex items-center">
                <div className={`w-2 h-2 rounded-full mr-2 ${
                  quoteAge < 15000 ? 'bg-green-400' :
                  quoteAge < 30000 ? 'bg-yellow-400' :
                  'bg-red-400'
                }`}></div>
                <span className={`${
                  quoteAge < 15000 ? 'text-green-400' :
                  quoteAge < 30000 ? 'text-yellow-400' :
                  'text-red-400'
                }`}>
                  Quote {formatQuoteAge(quoteAge)}
                  {quoteAge > 30000 && ' - Consider refreshing'}
                </span>
              </div>
              <span className="text-gray-400">Manual refresh only</span>
            </div>
          )}

          {/* Swap Details */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-400">You Pay:</span>
                <span className="text-white font-medium">
                  {amount} SOL
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">You Receive:</span>
                <span className="text-green-400 font-medium">
                  {formatTokenAmount(swapRoute.quote.outAmount)} Tokens
                </span>
              </div>
            </div>
            
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-400">Price Impact:</span>
                <span className={`font-medium ${
                  swapRoute.priceImpact > 5 ? 'text-red-400' : 
                  swapRoute.priceImpact > 1 ? 'text-yellow-400' : 'text-green-400'
                }`}>
                  {swapRoute.priceImpact.toFixed(2)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Est. Fees:</span>
                <span className="text-gray-300">
                  {swapRoute.estimatedFees.toFixed(6)} SOL
                </span>
              </div>
            </div>
          </div>

          {/* Route Information */}
          <div className="p-3 bg-white/5 rounded-lg">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Route:</span>
              <span className="text-white">
                {swapRoute.quote.routePlan?.length || 0} step(s) via Jupiter
              </span>
            </div>
            <div className="mt-2 text-xs text-gray-500">
              Best route found across {swapRoute.quote.routePlan?.length || 0} DEX(s)
            </div>
          </div>

          {/* Execute Button */}
          <button
            onClick={handleSwap}
            disabled={isExecuting || !publicKey}
            className={`w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200 ${
              isExecuting || !publicKey
                ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                : swapRoute.priceImpact > 5
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white transform hover:scale-105'
            }`}
          >
            {isExecuting ? (
              <span className="flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                Executing Swap...
              </span>
            ) : !publicKey ? (
              'Connect Wallet to Swap'
            ) : swapRoute.priceImpact > 5 ? (
              '⚠️ High Impact - Execute Anyway'
            ) : (
              '🚀 Execute Swap'
            )}
          </button>

          {/* Refresh Indicator */}
          <div className="text-center text-xs text-gray-500">
            Quote auto-refreshes every 10 seconds
          </div>
        </div>
      )}
    </div>
  )
}

export default SwapQuote
