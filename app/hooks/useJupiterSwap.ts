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

  // Check if a token is tradeable on Jupiter
  const isTokenTradeable = useCallback(async (mintAddress: string): Promise<boolean> => {
    try {
      // Validate mint address format
      new PublicKey(mintAddress)
      
      // Try a small quote to see if the token is tradeable
      const testQuote = await jupiterApi.quoteGet({
        inputMint: SOL_MINT,
        outputMint: mintAddress,
        amount: 1000000, // 0.001 SOL
        slippageBps: 1000, // 10%
        onlyDirectRoutes: true // Only direct routes for validation
      })
      
      return testQuote !== null
    } catch (error) {
      return false
    }
  }, [jupiterApi])

  const SOL_MINT = 'So11111111111111111111111111111111111111112'

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

    // Skip if already loading to prevent multiple concurrent requests
    if (swapRoute.loading) {
      console.log('⏳ Quote request already in progress, skipping...')
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

      // Add timeout and retry logic
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

      try {      // Validate mint addresses first
      try {
        new PublicKey(inputMint)
        new PublicKey(outputMint)
      } catch (validationError) {
        throw new Error('Invalid mint address format')
      }

      // Skip validation for SOL-to-SOL or common tokens to avoid extra API calls
      const commonTokens = [
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      ]
      
      if (!commonTokens.includes(outputMint)) {
        console.log('🔍 Checking if token is tradeable on Jupiter...')
        const isTradeable = await isTokenTradeable(outputMint)
        if (!isTradeable) {
          throw new Error('This token is not available for trading on Jupiter')
        }
        console.log('✅ Token is tradeable on Jupiter')
      }

        // Get quote from Jupiter with timeout
        const quote = await jupiterApi.quoteGet({
          inputMint,
          outputMint,
          amount: inputAmount,
          slippageBps,
          onlyDirectRoutes: false,
          asLegacyTransaction: false
        })

        clearTimeout(timeoutId)

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

      } catch (fetchError) {
        clearTimeout(timeoutId)
        throw fetchError
      }

    } catch (error) {
      console.error('❌ Error getting Jupiter quote:', error)
      
      // Better error handling based on error type
      let errorMessage = 'Failed to get swap quote'
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          errorMessage = 'Request timeout - Jupiter API is slow'
        } else if (error.message.includes('NetworkError')) {
          errorMessage = 'Network error - check internet connection'
        } else if (error.message.includes('fetch')) {
          errorMessage = 'Jupiter API temporarily unavailable'
        } else if (error.message.includes('Invalid mint address')) {
          errorMessage = 'Invalid token address format'
        } else {
          errorMessage = error.message
        }
      }
      
      // Handle Jupiter API specific errors
      if (error && typeof error === 'object' && 'response' in error) {
        const response = (error as any).response
        if (response?.status === 400) {
          errorMessage = 'This token is not tradeable on Jupiter or the pair does not exist'
        } else if (response?.status === 404) {
          errorMessage = 'Token not found in Jupiter database'
        } else if (response?.status === 429) {
          errorMessage = 'Too many requests - please wait a moment'
        } else if (response?.status >= 500) {
          errorMessage = 'Jupiter API server error - try again later'
        }
      }
      
      // Check if it's a ResponseError (Jupiter API specific)
      if (error?.constructor?.name === 'ResponseError') {
        errorMessage = 'This token pair is not available for trading on Jupiter'
      }
      
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
  }, [connection, jupiterApi, swapRoute.loading])

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
    clearRoute,
    isTokenTradeable
  }
}
