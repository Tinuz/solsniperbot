'use client'

import React, { useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { useMintDetection, NewToken } from '../hooks/useMintDetection'

interface MintDetectionProps {
  onTokenSelect: (mint: string) => void
}

const MintDetection: React.FC<MintDetectionProps> = ({ onTokenSelect }) => {
  const { connection } = useConnection()
  const [isMonitoring, setIsMonitoring] = useState(false)
  
  const {
    detectedTokens,
    isConnected,
    isMonitoring: actuallyMonitoring,
    heartbeatCount,
    lastHeartbeat,
    accountsProcessed,
    pollingResults,
    clearDetectedTokens,
    removeToken
  } = useMintDetection(connection, isMonitoring)

  // Debug: log token state changes
  React.useEffect(() => {
    console.log('🔍 MintDetection: detectedTokens changed:', detectedTokens.length, detectedTokens)
  }, [detectedTokens])

  const toggleMonitoring = () => {
    setIsMonitoring(!isMonitoring)
  }

  // Demo function to simulate token detection for testing
  const addDemoToken = () => {
    const demoMints = [
      'So11111111111111111111111111111111111111112', // Wrapped SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
    ]
    
    const randomMint = demoMints[Math.floor(Math.random() * demoMints.length)]
    onTokenSelect(randomMint)
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString()
  }

  const formatMint = (mint: string) => {
    return `${mint.slice(0, 8)}...${mint.slice(-8)}`
  }

  const formatLastHeartbeat = () => {
    if (!lastHeartbeat) return ''
    const ago = Math.floor((Date.now() - lastHeartbeat) / 1000)
    if (ago < 60) return `${ago}s ago`
    return `${Math.floor(ago / 60)}m ago`
  }

  const handleTokenClick = (mint: string) => {
    onTokenSelect(mint)
  }

  return (
    <div className="bg-white/10 backdrop-blur-md rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-white mb-1">
            🔍 Real-time Mint Detection
          </h2>
          <div className="flex items-center space-x-4 text-sm">
            <div className={`flex items-center ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
              {isConnected ? 'Connected' : 'Disconnected'}
            </div>
            <div className="text-gray-300">
              Detected: {detectedTokens.length} tokens
            </div>
            {actuallyMonitoring && heartbeatCount > 0 && (
              <div className="flex items-center text-blue-400">
                <div className="w-2 h-2 bg-blue-400 rounded-full mr-2 animate-pulse"></div>
                <span className="text-xs">
                  Heartbeat #{heartbeatCount} {formatLastHeartbeat()}
                </span>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex space-x-2">
          <button
            onClick={addDemoToken}
            className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg text-sm font-medium transition-colors"
            title="Add a demo token for testing"
          >
            Demo Token
          </button>
          {detectedTokens.length > 0 && (
            <button
              onClick={clearDetectedTokens}
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition-colors"
            >
              Clear All
            </button>
          )}
          <button
            onClick={toggleMonitoring}
            className={`px-6 py-2 rounded-lg font-medium transition-all duration-200 ${
              actuallyMonitoring
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {actuallyMonitoring ? '⏹️ Stop Monitoring' : '▶️ Start Monitoring'}
          </button>
        </div>
      </div>

      {actuallyMonitoring && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <div className="flex items-center justify-between text-blue-400">
            <div className="flex items-center">
              <div className="animate-pulse w-3 h-3 bg-blue-400 rounded-full mr-3"></div>
              <span className="text-sm font-medium">
                Monitoring for new token mints... 
                {heartbeatCount > 0 && ` (${heartbeatCount} heartbeats)`}
              </span>
            </div>
            {heartbeatCount > 0 && (
              <div className="text-xs text-blue-300">
                Last: {formatLastHeartbeat()}
              </div>
            )}
          </div>
          
          {/* Detailed monitoring stats */}
          <div className="mt-2 pt-2 border-t border-blue-500/20">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="text-blue-300">
                <span className="text-blue-500">WebSocket Events:</span> {accountsProcessed}
              </div>
              <div className="text-blue-300">
                <span className="text-blue-500">Activity Check:</span> {pollingResults || 0}
              </div>
            </div>
            <div className="mt-1 text-xs text-blue-300">
              💡 Dual detection: WebSocket (real-time) + Light polling (activity check)
            </div>
          </div>
        </div>
      )}

      {/* Detected Tokens List */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {detectedTokens.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            {actuallyMonitoring 
              ? 'Listening for new tokens... 👂' 
              : 'Start monitoring to detect new token mints'
            }
          </div>
        ) : (
          detectedTokens.map((token) => (
            <div
              key={`${token.mint}-${token.timestamp}`}
              className="flex items-center justify-between p-3 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 hover:border-purple-500/30 transition-all duration-200 cursor-pointer group"
              onClick={() => handleTokenClick(token.mint)}
            >
              <div className="flex-1">
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                  <div>
                    <div className="font-mono text-white text-sm">
                      {formatMint(token.mint)}
                    </div>
                    <div className="text-xs text-gray-400">
                      {token.name} • {formatTime(token.timestamp)}
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex items-center space-x-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleTokenClick(token.mint)
                  }}
                  className="px-3 py-1 bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 rounded text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  Use This
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeToken(token.mint)
                  }}
                  className="p-1 text-gray-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {detectedTokens.length > 5 && (
        <div className="mt-4 text-center">
          <div className="text-xs text-gray-400">
            Showing latest {detectedTokens.length} tokens • Click on a token to use it for sniping
          </div>
        </div>
      )}
    </div>
  )
}

export default MintDetection
