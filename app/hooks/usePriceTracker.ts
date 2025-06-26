'use client'

import { useState, useCallback } from 'react'
import { TrackedToken } from '../components/PriceTracker'

export const usePriceTracker = () => {
  const [trackedTokens, setTrackedTokens] = useState<TrackedToken[]>([])

  // LocalStorage key
  const TRACKED_TOKENS_KEY = 'solsniperbot_tracked_tokens'

  // Load tracked tokens from localStorage
  const loadTrackedTokens = useCallback((): TrackedToken[] => {
    if (typeof window === 'undefined') return []
    try {
      const stored = localStorage.getItem(TRACKED_TOKENS_KEY)
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
      localStorage.setItem(TRACKED_TOKENS_KEY, JSON.stringify(tokens))
    } catch (error) {
      console.warn('Failed to save tracked tokens:', error)
    }
  }, [])

  // Add a token to price tracking
  const addTokenToTracking = useCallback((
    mint: string,
    name: string,
    symbol: string,
    purchasePrice: number,
    purchaseAmount: number
  ) => {
    const currentTokens = loadTrackedTokens()
    
    // Check if token is already being tracked
    const existingToken = currentTokens.find(token => token.mint === mint)
    if (existingToken) {
      console.log(`Token ${name} is already being tracked`)
      return false
    }

    const newToken: TrackedToken = {
      mint,
      name,
      symbol,
      purchasePrice,
      purchaseAmount,
      purchaseTimestamp: Date.now(),
      currentPrice: purchasePrice, // Start with purchase price
      lastPriceUpdate: Date.now(),
      isLoading: false
    }

    const updatedTokens = [newToken, ...currentTokens]
    saveTrackedTokens(updatedTokens)
    setTrackedTokens(updatedTokens)

    console.log(`📊 Added ${name} (${symbol}) to price tracking`)
    return true
  }, [loadTrackedTokens, saveTrackedTokens])

  // Remove token from tracking
  const removeTokenFromTracking = useCallback((mint: string) => {
    const currentTokens = loadTrackedTokens()
    const updatedTokens = currentTokens.filter(token => token.mint !== mint)
    saveTrackedTokens(updatedTokens)
    setTrackedTokens(updatedTokens)
    
    console.log(`🗑️ Removed token from tracking: ${mint.slice(0, 8)}`)
  }, [loadTrackedTokens, saveTrackedTokens])

  // Check if a token is being tracked
  const isTokenTracked = useCallback((mint: string): boolean => {
    const currentTokens = loadTrackedTokens()
    return currentTokens.some(token => token.mint === mint)
  }, [loadTrackedTokens])

  // Get tracked token count
  const getTrackedTokenCount = useCallback((): number => {
    const currentTokens = loadTrackedTokens()
    return currentTokens.length
  }, [loadTrackedTokens])

  return {
    trackedTokens,
    setTrackedTokens,
    addTokenToTracking,
    removeTokenFromTracking,
    isTokenTracked,
    getTrackedTokenCount,
    loadTrackedTokens,
    saveTrackedTokens
  }
}
