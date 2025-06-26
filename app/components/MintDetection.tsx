'use client'

import React, { useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { useMintDetection, NewToken } from '../hooks/useMintDetection'
import { usePriceTracker } from '../hooks/usePriceTracker'

interface MintDetectionProps {
  onTokenSelect: (mint: string) => void
  onMarkTokenAsSnipedRef?: (markTokenAsSniped: (mint: string, snipeData?: { amount?: number; price?: number; signature?: string }) => void) => void
}

const MintDetection: React.FC<MintDetectionProps> = ({ onTokenSelect, onMarkTokenAsSnipedRef }) => {
  const { connection } = useConnection()
  const [isMonitoring, setIsMonitoring] = useState(false)
  const [activeTab, setActiveTab] = useState<'detected' | 'sniped'>('detected')
  const { addTokenToTracking, isTokenTracked } = usePriceTracker()
  
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
    resetRateLimitBackoff,
    repairMarketCheckQueue,
    updateTokenMetadata
  } = useMintDetection(connection, isMonitoring)

  // Setup callback ref for markTokenAsSniped
  React.useEffect(() => {
    if (onMarkTokenAsSnipedRef) {
      onMarkTokenAsSnipedRef(markTokenAsSniped)
    }
  }, [markTokenAsSniped, onMarkTokenAsSnipedRef])

  // Pass markTokenAsSniped function to parent
  React.useEffect(() => {
    if (onMarkTokenAsSnipedRef) {
      onMarkTokenAsSnipedRef(markTokenAsSniped)
    }
  }, [onMarkTokenAsSnipedRef, markTokenAsSniped])

  const toggleMonitoring = () => {
    setIsMonitoring(!isMonitoring)
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

  const shouldShowRepairButton = () => {
    const tokensNeedingCheck = detectedTokens.filter(t => 
      t.marketStatus !== 'available' && 
      (t.marketCheckCount || 0) < 10
    );
    const queueIsEmpty = marketCheckQueue === 0;
    
    // Only show repair button when queue is empty but tokens need checking
    return queueIsEmpty && tokensNeedingCheck.length > 0;
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

  const handleAddToTracking = async (e: React.MouseEvent, token: NewToken) => {
    e.stopPropagation()
    
    // Add token to price tracking (default purchase price of 0.001 SOL and 1M tokens)
    const defaultPurchasePrice = 0.001 // SOL
    const defaultAmount = 1000000 // tokens
    
    const added = addTokenToTracking(
      token.mint,
      token.name || `Token-${token.mint.slice(0, 8)}`,
      token.symbol || 'NEW',
      defaultPurchasePrice,
      defaultAmount
    )
    
    if (added) {
      alert(`📊 Token added to price tracking!\n\nYou can now monitor its price in the Price Tracker tab.`)
    } else {
      alert(`This token is already being tracked.`)
    }
  }

  return (
    <div>
      {/* Header with title and connection status */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-white">
          🔍 Token Detection & Sniping
        </h2>
        
        {/* Connection Status */}
        <div className={`flex items-center text-sm ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
          <div className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      {/* Tab Navigation and Controls Row */}
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-center gap-3">
          {/* Tab Navigation */}
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
          
          {/* Heartbeat Status */}
          {actuallyMonitoring && heartbeatCount > 0 && (
            <div className="flex items-center text-blue-400 text-sm">
              <div className="w-2 h-2 bg-blue-400 rounded-full mr-2 animate-pulse"></div>
              <span className="text-xs">
                Heartbeat #{heartbeatCount} {formatLastHeartbeat()}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Repair button - only when queue is empty but tokens need checking */}
          {shouldShowRepairButton() && (
            <button
              onClick={repairMarketCheckQueue}
              className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition-colors"
              title="Repair market check queue - add tokens that need checking back to queue"
            >
              🔧 Repair Queue
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
      
      {/* Aggressive Settings Info */}
      {actuallyMonitoring && activeTab === 'detected' && (
        <div className="mb-4 p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
          <div className="flex items-center text-orange-400">
            <div className="text-lg mr-2">⚡</div>
            <div className="text-sm">
              <div className="font-medium">Aggressive Mode Active</div>
              <div className="text-xs text-orange-300 mt-1">
                Market checks: 30s interval • 5s min delay • 3 tokens parallel • 0.5s stagger
              </div>
              {marketCheckQueue > 0 && (
                <div className="text-xs text-orange-300 mt-1">
                  Queue: {marketCheckQueue} tokens waiting
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Token Lists */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {activeTab === 'detected' ? (
          detectedTokens.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              {actuallyMonitoring ? (
                <div>
                  <div className="text-lg mb-2">👂 Listening for new tokens...</div>
                  <div className="text-sm">
                    New token mints will appear here automatically.
                    <br />
                    Market availability will be checked within 2 minutes.
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-lg mb-2">� Ready to detect new tokens</div>
                  <div className="text-sm">
                    Click &ldquo;Start Monitoring&rdquo; to begin detecting new token mints on Solana
                  </div>
                </div>
              )}
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
                            {/* Token name and symbol - prominently displayed */}
                            <div className="flex items-center space-x-2">
                              <div className="text-white text-sm font-medium">
                                {token.name || `Token-${token.mint.slice(0, 8)}`}
                              </div>
                              {token.symbol && token.symbol !== 'NEW' && (
                                <div className="px-2 py-0.5 bg-purple-600/20 text-purple-300 rounded text-xs font-mono">
                                  {token.symbol}
                                </div>
                              )}
                            </div>
                            {/* Mint address and timestamp - secondary info */}
                            <div className="text-xs text-gray-400 font-mono">
                              {formatMint(token.mint)} • {formatTime(token.timestamp)}
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
                    {/* Refresh metadata button for tokens with default names */}
                    {(token.name?.startsWith('Token-') || token.symbol === 'NEW') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          updateTokenMetadata(token.mint)
                        }}
                        className="px-2 py-1 bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 rounded text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Refresh token name and symbol"
                      >
                        🔄 Name
                      </button>
                    )}
                    
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
                    
                    {/* Track Price button - only for available tokens */}
                    {token.marketStatus === 'available' && !isTokenTracked(token.mint) && (
                      <button
                        onClick={(e) => handleAddToTracking(e, token)}
                        className="px-2 py-1 bg-green-600/20 hover:bg-green-600/40 text-green-400 rounded text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Add to price tracking"
                      >
                        📊 Track Price
                      </button>
                    )}
                    
                    {/* Already tracking indicator */}
                    {token.marketStatus === 'available' && isTokenTracked(token.mint) && (
                      <span className="px-2 py-1 bg-green-600/10 text-green-400 rounded text-xs font-medium opacity-70">
                        📊 Tracked
                      </span>
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
                          {/* Token name and symbol - prominently displayed */}
                          <div className="flex items-center space-x-2">
                            <div className="text-white text-sm font-medium">
                              {token.name || `Token-${token.mint.slice(0, 8)}`}
                            </div>
                            {token.symbol && token.symbol !== 'NEW' && (
                              <div className="px-2 py-0.5 bg-green-600/20 text-green-300 rounded text-xs font-mono">
                                {token.symbol}
                              </div>
                            )}
                          </div>
                          {/* Snipe info and mint address - secondary info */}
                          <div className="text-xs text-gray-400">
                            <span className="font-mono">{formatMint(token.mint)}</span> • Sniped: {formatTime(token.snipedAt)}
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
