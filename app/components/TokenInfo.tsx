'use client'

import React, { useState, useEffect } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'

interface TokenInfoProps {
  tokenAddress: string
}

interface TokenMetadata {
  name?: string
  symbol?: string
  decimals?: number
  supply?: number
  isValid?: boolean
  error?: string
}

const TokenInfo: React.FC<TokenInfoProps> = ({ tokenAddress }) => {
  const { connection } = useConnection()
  const [metadata, setMetadata] = useState<TokenMetadata | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!tokenAddress || !connection) {
      setMetadata(null)
      return
    }

    const fetchTokenInfo = async () => {
      setLoading(true)
      try {
        const mintPubkey = new PublicKey(tokenAddress)
        const mintInfo = await connection.getAccountInfo(mintPubkey)
        
        if (!mintInfo) {
          setMetadata({ isValid: false, error: 'Token not found' })
          return
        }

        // Basic token validation
        const isTokenMint = mintInfo.data.length >= 82 // Standard mint size
        
        setMetadata({
          name: `Token ${tokenAddress.slice(0, 8)}`,
          symbol: 'TKN',
          decimals: 9, // Default for most tokens
          supply: 0,
          isValid: isTokenMint,
          error: isTokenMint ? undefined : 'Invalid token mint'
        })
      } catch (error) {
        setMetadata({ 
          isValid: false, 
          error: error instanceof Error ? error.message : 'Invalid token address' 
        })
      } finally {
        setLoading(false)
      }
    }

    fetchTokenInfo()
  }, [tokenAddress, connection])

  if (!tokenAddress) return null

  return (
    <div className="mt-4 p-4 bg-white/5 border border-white/10 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-white">Token Information</h4>
        {loading && (
          <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
        )}
      </div>
      
      {loading ? (
        <div className="space-y-2">
          <div className="h-4 bg-white/10 rounded animate-pulse"></div>
          <div className="h-4 bg-white/10 rounded animate-pulse w-2/3"></div>
        </div>
      ) : metadata ? (
        <div className="space-y-2 text-sm">
          {metadata.isValid ? (
            <>
              <div className="flex justify-between">
                <span className="text-gray-400">Name:</span>
                <span className="text-white">{metadata.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Symbol:</span>
                <span className="text-white">{metadata.symbol}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Decimals:</span>
                <span className="text-white">{metadata.decimals}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Status:</span>
                <div className="flex items-center">
                  <div className="w-2 h-2 bg-green-400 rounded-full mr-2"></div>
                  <span className="text-green-400">Valid Token</span>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Status:</span>
              <div className="flex items-center">
                <div className="w-2 h-2 bg-red-400 rounded-full mr-2"></div>
                <span className="text-red-400">{metadata.error}</span>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default TokenInfo
