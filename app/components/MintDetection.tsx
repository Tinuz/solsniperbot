'use client'

import React, { useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { useMintDetection, NewToken, SnipedToken } from '../hooks/useMintDetection'

interface MintDetectionProps {
  onTokenSelect: (mint: string) => void
  onMarkTokenAsSnipedRef?: (markTokenAsSniped: (mint: string, snipeData?: { amount?: number; price?: number; signature?: string }) => void) => void
}

const MintDetection: React.FC<MintDetectionProps> = ({ onTokenSelect, onMarkTokenAsSnipedRef }) => {
  const { connection } = useConnection()
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [activeTab, setActiveTab] = useState<'detected' | 'sniped'>('detected')
  
  const {
    detectedTokens,
    snipedTokens,
    isConnected,
    isMonitoring: actuallyMonitoring,
    heartbeatCount,
    lastHeartbeat,
    accountsProcessed,
    pollingResults,
    marketCheckQueue,
    rateLimitBackoff,
    clearDetectedTokens,
    removeToken,
    markTokenAsSniped,
    clearSnipedTokens,
    removeSnipedToken,
    checkTokenMarket,
    debugForceMarketCheck,
    resetRateLimitBackoff
  } = useMintDetection(connection, isMonitoring)

  // Setup callback ref for markTokenAsSniped
  React.useEffect(() => {
    if (onMarkTokenAsSnipedRef) {
      onMarkTokenAsSnipedRef(markTokenAsSniped)
    }
  }, [markTokenAsSniped, onMarkTokenAsSnipedRef])

  // Debug: log token state changes
  React.useEffect(() => {
    console.log('🔍 MintDetection: detectedTokens changed:', detectedTokens.length, detectedTokens)
  }, [detectedTokens])

  // Pass markTokenAsSniped function to parent
  React.useEffect(() => {
    if (onMarkTokenAsSnipedRef) {
      onMarkTokenAsSnipedRef(markTokenAsSniped)
    }
  }, [onMarkTokenAsSnipedRef, markTokenAsSniped])

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

  const getMarketStatusDisplay = (token: NewToken) => {
    switch (token.marketStatus) {
      case 'checking':
        return {
          icon: '🔄',
          text: 'Checking market...',
          color: 'text-blue-400',
          bgColor: 'bg-blue-500/10',
          borderColor: 'border-blue-500/20'
        }
      case 'available':
        return {
          icon: '✅',
          text: 'Market available',
          color: 'text-green-400',
          bgColor: 'bg-green-500/10',
          borderColor: 'border-green-500/20'
        }
      case 'not-available':
        return {
          icon: '⏳',
          text: 'No market yet',
          color: 'text-yellow-400',
          bgColor: 'bg-yellow-500/10',
          borderColor: 'border-yellow-500/20'
        }
      case 'error':
        return {
          icon: '❌',
          text: 'Check failed',
          color: 'text-red-400',
          bgColor: 'bg-red-500/10',
          borderColor: 'border-red-500/20'
        }
      default:
        return {
          icon: '🔍',
          text: 'Pending check',
          color: 'text-gray-400',
          bgColor: 'bg-gray-500/10',
          borderColor: 'border-gray-500/20'
        }
    }
  }

  const handleTokenClick = (mint: string) => {
    onTokenSelect(mint)
  }

  const handleManualMarketCheck = async (e: React.MouseEvent, mint: string) => {
    e.stopPropagation()
    await checkTokenMarket(mint)
  }

  return (
    <div className="bg-white/10 backdrop-blur-md rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-white mb-1">
            🔍 Token Detection & Sniping
          </h2>
          
          {/* Tab Navigation */}
          <div className="flex items-center space-x-4 mb-2">
            <div className="flex bg-white/5 rounded-lg p-1">
              <button
                onClick={() => setActiveTab('detected')}
                className={`px-3 py-1 rounded text-sm font-medium transition-all ${
                  activeTab === 'detected'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                New Tokens ({detectedTokens.length})
              </button>
              <button
                onClick={() => setActiveTab('sniped')}
                className={`px-3 py-1 rounded text-sm font-medium transition-all ${
                  activeTab === 'sniped'
                    ? 'bg-green-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Sniped ({snipedTokens.length})
              </button>
            </div>
          </div>
          
          <div className="flex items-center space-x-4 text-sm">
            <div className={`flex items-center ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
              <div className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
              {isConnected ? 'Connected' : 'Disconnected'}
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
          
          {marketCheckQueue > 0 && (
            <button
              onClick={debugForceMarketCheck}
              disabled={rateLimitBackoff > 0}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                rateLimitBackoff > 0 
                  ? 'bg-gray-600/20 text-gray-500 cursor-not-allowed' 
                  : 'bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400'
              }`}
              title={rateLimitBackoff > 0 ? 'Rate limited - please wait' : 'Force check market queue now'}
            >
              {rateLimitBackoff > 0 ? 'Rate Limited' : `Force Check (${marketCheckQueue})`}
            </button>
          )}
          
          {activeTab === 'detected' && detectedTokens.length > 0 && (
            <button
              onClick={clearDetectedTokens}
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition-colors"
            >
              Clear New
            </button>
          )}
          
          {activeTab === 'sniped' && snipedTokens.length > 0 && (
            <button
              onClick={clearSnipedTokens}
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition-colors"
            >
              Clear Sniped
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

      {actuallyMonitoring && activeTab === 'detected' && (
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
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div className="text-blue-300">
                <span className="text-blue-500">WebSocket Events:</span> {accountsProcessed}
              </div>
              <div className="text-blue-300">
                <span className="text-blue-500">Activity Check:</span> {pollingResults || 0}
              </div>
              <div className="text-blue-300">
                <span className="text-blue-500">Market Queue:</span> {marketCheckQueue}
              </div>
            </div>
            {rateLimitBackoff > 0 && (
              <div className="mt-1 text-xs text-yellow-400 bg-yellow-500/10 p-2 rounded flex items-center justify-between">
                <span>⏱️ Rate limited - backoff level {rateLimitBackoff} (checks paused)</span>
                <button
                  onClick={resetRateLimitBackoff}
                  className="ml-2 px-2 py-1 bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-300 rounded text-xs"
                  title="Reset rate limit backoff"
                >
                  Reset
                </button>
              </div>
            )}
            <div className="mt-1 text-xs text-blue-300">
              💡 Real-time detection + Market availability checking
            </div>
          </div>
        </div>
      )}

      {/* Token Lists */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {activeTab === 'detected' ? (
          detectedTokens.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              {actuallyMonitoring 
                ? 'Listening for new tokens... 👂' 
                : 'Start monitoring to detect new token mints'
              }
            </div>
          ) : (
            detectedTokens.map((token) => {
              const marketStatus = getMarketStatusDisplay(token)
              return (
                <div
                  key={`${token.mint}-${token.timestamp}`}
                  className="flex items-center justify-between p-3 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 hover:border-purple-500/30 transition-all duration-200 cursor-pointer group"
                  onClick={() => handleTokenClick(token.mint)}
                >
                  <div className="flex-1">
                    <div className="flex items-center space-x-3">
                      <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-mono text-white text-sm">
                              {formatMint(token.mint)}
                            </div>
                            <div className="text-xs text-gray-400">
                              {token.name} • {formatTime(token.timestamp)}
                            </div>
                          </div>
                          
                          {/* Market Status Indicator */}
                          <div className={`flex items-center space-x-2 px-2 py-1 rounded-md ${marketStatus.bgColor} border ${marketStatus.borderColor}`}>
                            <span className="text-xs">
                              {token.marketStatus === 'checking' ? (
                                <span className="animate-spin">🔄</span>
                              ) : (
                                marketStatus.icon
                              )}
                            </span>
                            <span className={`text-xs font-medium ${marketStatus.color}`}>
                              {marketStatus.text}
                            </span>
                            {token.marketCheckCount && token.marketCheckCount > 0 && (
                              <span className="text-xs text-gray-500">
                                ({token.marketCheckCount})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center space-x-2 ml-4">
                    {/* Manual market check button */}
                    {token.marketStatus !== 'available' && (
                      <button
                        onClick={(e) => handleManualMarketCheck(e, token.mint)}
                        className="px-2 py-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 rounded text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Check market availability now"
                      >
                        Check Now
                      </button>
                    )}
                    
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
              )
            })
          )
        ) : (
          // Sniped tokens tab
          snipedTokens.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              No sniped tokens yet. Start sniping to see them here! 🎯
            </div>
          ) : (
            snipedTokens.map((token) => (
              <div
                key={`sniped-${token.mint}-${token.snipedAt}`}
                className="flex items-center justify-between p-3 bg-green-500/5 hover:bg-green-500/10 rounded-lg border border-green-500/20 hover:border-green-500/40 transition-all duration-200 cursor-pointer group"
                onClick={() => handleTokenClick(token.mint)}
              >
                <div className="flex-1">
                  <div className="flex items-center space-x-3">
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-mono text-white text-sm">
                            {formatMint(token.mint)}
                          </div>
                          <div className="text-xs text-gray-400">
                            Sniped: {formatTime(token.snipedAt)}
                            {token.snipeAmount && (
                              <span className="text-green-400 ml-2">
                                • {token.snipeAmount} SOL
                              </span>
                            )}
                          </div>
                        </div>
                        
                        {/* Sniped indicator */}
                        <div className="flex items-center space-x-2 px-2 py-1 rounded-md bg-green-500/10 border border-green-500/20">
                          <span className="text-xs">🎯</span>
                          <span className="text-xs font-medium text-green-400">
                            Sniped
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center space-x-2 ml-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleTokenClick(token.mint)
                    }}
                    className="px-3 py-1 bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 rounded text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    Trade Again
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeSnipedToken(token.mint)
                    }}
                    className="p-1 text-gray-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))
          )
        )}
      </div>

      {/* Footer Stats */}
      {activeTab === 'detected' && detectedTokens.length > 5 && (
        <div className="mt-4 text-center">
          <div className="text-xs text-gray-400">
            Showing latest {detectedTokens.length} tokens • Click on a token to use it for sniping
          </div>
        </div>
      )}
      
      {activeTab === 'sniped' && snipedTokens.length > 5 && (
        <div className="mt-4 text-center">
          <div className="text-xs text-gray-400">
            Showing latest {snipedTokens.length} sniped tokens • Click to trade again
          </div>
        </div>
      )}
    </div>
  )
}

export default MintDetection
