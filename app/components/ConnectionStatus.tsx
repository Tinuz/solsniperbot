'use client'

import React, { useState, useEffect } from 'react'
import HeliusConnection from '../services/HeliusConnection'

const ConnectionStatus: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false)
  const [stats, setStats] = useState<{
    currentSlot?: number;
    blockHeight?: number;
    epoch?: number;
    slotIndex?: number;
    slotsInEpoch?: number;
  } | null>(null)
  const [testing, setTesting] = useState(false)
  
  // Load collapsed state from localStorage, default to expanded
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('connectionStatus_expanded')
      return saved !== null ? saved === 'true' : true
    }
    return true
  })

  // Save expanded state to localStorage when it changes
  const toggleExpanded = () => {
    const newState = !isExpanded
    setIsExpanded(newState)
    if (typeof window !== 'undefined') {
      localStorage.setItem('connectionStatus_expanded', newState.toString())
    }
  }

  useEffect(() => {
    testConnection()
    // Reduced frequency from 30s to 2 minutes to avoid rate limiting
    const interval = setInterval(testConnection, 120000) // Test every 2 minutes
    return () => clearInterval(interval)
  }, [])

  const testConnection = async () => {
    setTesting(true)
    try {
      const connected = await HeliusConnection.testConnection()
      setIsConnected(connected)
      
      // Only fetch stats if basic connection test passed and we're not rate limited
      if (connected) {
        try {
          const connectionStats = await HeliusConnection.getConnectionStats()
          setStats(connectionStats)
        } catch {
          // Stats failed but connection is still valid
          console.warn('⚠️ Could not fetch connection stats, but connection is OK')
          setStats(null)
        }
      } else {
        setStats(null)
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.warn('Connection test error:', errorMessage)
      setIsConnected(false)
      setStats(null)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="bg-white/5 border border-white/10 rounded-lg">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center space-x-2">
          <h4 className="text-sm font-medium text-white flex items-center">
            🔗 Helius Connection Status
          </h4>
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
          {!isExpanded && (
            <span className={`text-xs ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={testConnection}
            disabled={testing}
            className="px-3 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded text-xs font-medium transition-colors disabled:opacity-50"
          >
            {testing ? '⏳' : '🔄'} Test
          </button>
          <button
            onClick={toggleExpanded}
            className="px-3 py-1 bg-gray-600/20 hover:bg-gray-600/30 text-gray-400 rounded text-xs font-medium transition-colors"
          >
            {isExpanded ? '🔽' : '🔼'} {isExpanded ? 'Inklappen' : 'Uitklappen'}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-2 text-sm border-t border-white/10 transition-all duration-300 ease-in-out">
          <div className="flex items-center justify-between pt-3">
            <span className="text-gray-400">Status:</span>
            <div className="flex items-center">
              <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-gray-400">Provider:</span>
            <span className="text-white">Helius RPC</span>
          </div>

          {stats && (
            <div className="space-y-2 animate-fadeIn">
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Current Slot:</span>
                <span className="text-white font-mono text-xs">
                  {stats.currentSlot?.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Block Height:</span>
                <span className="text-white font-mono text-xs">
                  {stats.blockHeight?.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Epoch:</span>
                <span className="text-white font-mono text-xs">
                  {stats.epoch}
                </span>
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-white/10">
            <div className="text-xs text-gray-500">
              Premium RPC endpoint for enhanced performance
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ConnectionStatus
