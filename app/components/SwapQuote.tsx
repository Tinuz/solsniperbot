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
  const { swapRoute, getSwapQuote, prepareSwapTransaction, executeSwap, clearRoute } = useJupiterSwap(connection)
  const [isExecuting, setIsExecuting] = useState(false)

  // Auto-refresh quote every 10 seconds
  useEffect(() => {
    if (!tokenAddress || !amount || parseFloat(amount) <= 0) {
      clearRoute()
      return
    }

    const fetchQuote = () => {
      const slippageBps = Math.floor(parseFloat(slippage) * 100) // Convert % to basis points
      getSwapQuote(SOL_MINT, tokenAddress, parseFloat(amount), slippageBps)
    }

    fetchQuote()

    // Auto-refresh every 10 seconds
    const interval = setInterval(fetchQuote, 10000)
    return () => clearInterval(interval)
  }, [tokenAddress, amount, slippage, getSwapQuote, clearRoute])

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
    return null
  }

  return (
    <div className="mt-4 p-4 bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/20 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-lg font-semibold text-white flex items-center">
          🔄 Jupiter Swap Quote
        </h4>
        {swapRoute.loading && (
          <div className="flex items-center text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mr-2"></div>
            Loading...
          </div>
        )}
      </div>

      {swapRoute.error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="text-red-400 text-sm">
            ❌ {swapRoute.error}
          </div>
        </div>
      )}

      {swapRoute.quote && !swapRoute.loading && (
        <div className="space-y-3">
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
