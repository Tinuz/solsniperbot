'use client'

import { useCallback, useState } from 'react'
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { createJupiterApiClient, QuoteResponse, SwapResponse } from '@jup-ag/api'

export interface SwapRoute {
  quote: QuoteResponse | null
  swapTransaction: VersionedTransaction | null
  loading: boolean
  error: string | null
  priceImpact: number
  minimumReceived: string
  estimatedFees: number
}

export const useJupiterSwap = (connection: Connection | null) => {
  const [swapRoute, setSwapRoute] = useState<SwapRoute>({
    quote: null,
    swapTransaction: null,
    loading: false,
    error: null,
    priceImpact: 0,
    minimumReceived: '0',
    estimatedFees: 0
  })

  const jupiterApi = createJupiterApiClient()

  const getSwapQuote = useCallback(async (
    inputMint: string,  // SOL mint
    outputMint: string, // Target token mint
    amount: number,     // Amount in SOL
    slippageBps: number = 300 // 3% slippage default
  ) => {
    if (!connection) {
      setSwapRoute(prev => ({ ...prev, error: 'No connection available' }))
      return null
    }

    setSwapRoute(prev => ({ 
      ...prev, 
      loading: true, 
      error: null,
      quote: null,
      swapTransaction: null 
    }))

    try {
      // Convert SOL amount to lamports
      const inputAmount = Math.floor(amount * 1e9)
      
      console.log('🔍 Getting Jupiter quote for:', {
        inputMint,
        outputMint,
        amount: inputAmount,
        slippageBps
      })

      // Get quote from Jupiter
      const quote = await jupiterApi.quoteGet({
        inputMint,
        outputMint,
        amount: inputAmount,
        slippageBps,
        onlyDirectRoutes: false,
        asLegacyTransaction: false
      })

      if (!quote) {
        throw new Error('No quote available for this token pair')
      }

      // Calculate price impact and minimum received
      const priceImpact = parseFloat(quote.priceImpactPct || '0')
      const outAmount = parseInt(quote.outAmount)
      const minimumReceived = (outAmount * (1 - slippageBps / 10000)).toString()

      // Estimate fees (simplified)
      const estimatedFees = quote.routePlan.reduce((total: number, route: any) => {
        return total + (route.swapInfo?.feeAmount ? parseInt(route.swapInfo.feeAmount) : 5000)
      }, 0)

      setSwapRoute({
        quote,
        swapTransaction: null,
        loading: false,
        error: null,
        priceImpact,
        minimumReceived,
        estimatedFees: estimatedFees / 1e9 // Convert to SOL
      })

      console.log('✅ Jupiter quote received:', {
        inputAmount: inputAmount / 1e9,
        outputAmount: outAmount,
        priceImpact: priceImpact.toFixed(2) + '%',
        routes: quote.routePlan.length
      })

      return quote

    } catch (error) {
      console.error('❌ Error getting Jupiter quote:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to get swap quote'
      
      setSwapRoute({
        quote: null,
        swapTransaction: null,
        loading: false,
        error: errorMessage,
        priceImpact: 0,
        minimumReceived: '0',
        estimatedFees: 0
      })
      
      return null
    }
  }, [connection, jupiterApi])

  const prepareSwapTransaction = useCallback(async (
    quote: QuoteResponse,
    userPublicKey: PublicKey,
    wrapAndUnwrapSol: boolean = true
  ) => {
    if (!connection || !quote) {
      setSwapRoute(prev => ({ ...prev, error: 'Missing quote or connection' }))
      return null
    }

    setSwapRoute(prev => ({ ...prev, loading: true, error: null }))

    try {
      console.log('🔨 Preparing swap transaction...')

      // Get swap transaction from Jupiter
      const swapResult = await jupiterApi.swapPost({
        swapRequest: {
          quoteResponse: quote,
          userPublicKey: userPublicKey.toString(),
          wrapAndUnwrapSol
        }
      })

      if (!swapResult.swapTransaction) {
        throw new Error('Failed to create swap transaction')
      }

      // Deserialize the transaction
      const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64')
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf)

      setSwapRoute(prev => ({
        ...prev,
        swapTransaction: transaction,
        loading: false,
        error: null
      }))

      console.log('✅ Swap transaction prepared')
      return transaction

    } catch (error) {
      console.error('❌ Error preparing swap transaction:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to prepare transaction'
      
      setSwapRoute(prev => ({
        ...prev,
        swapTransaction: null,
        loading: false,
        error: errorMessage
      }))
      
      return null
    }
  }, [connection, jupiterApi])

  const executeSwap = useCallback(async (
    transaction: VersionedTransaction,
    wallet: any
  ) => {
    if (!connection || !wallet || !transaction) {
      throw new Error('Missing required parameters for swap execution')
    }

    try {
      console.log('🚀 Executing swap transaction...')

      // Sign the transaction
      const signedTransaction = await wallet.signTransaction(transaction)
      
      // Send and confirm transaction
      const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      })

      console.log('📋 Transaction signature:', signature)

      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(signature, 'confirmed')
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`)
      }

      console.log('✅ Swap executed successfully!')
      return signature

    } catch (error) {
      console.error('❌ Error executing swap:', error)
      throw error
    }
  }, [connection])

  const clearRoute = useCallback(() => {
    setSwapRoute({
      quote: null,
      swapTransaction: null,
      loading: false,
      error: null,
      priceImpact: 0,
      minimumReceived: '0',
      estimatedFees: 0
    })
  }, [])

  return {
    swapRoute,
    getSwapQuote,
    prepareSwapTransaction,
    executeSwap,
    clearRoute
  }
}
