'use client'

import React, { useState, useEffect } from 'react'
import HeliusConnection from '../services/HeliusConnection'

const ConnectionStatus: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    testConnection()
    const interval = setInterval(testConnection, 30000) // Test every 30 seconds
    return () => clearInterval(interval)
  }, [])

  const testConnection = async () => {
    setTesting(true)
    try {
      const connected = await HeliusConnection.testConnection()
      setIsConnected(connected)
      
      if (connected) {
        const connectionStats = await HeliusConnection.getConnectionStats()
        setStats(connectionStats)
      }
    } catch (error) {
      setIsConnected(false)
      setStats(null)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-white flex items-center">
          🔗 Helius Connection Status
        </h4>
        <button
          onClick={testConnection}
          disabled={testing}
          className="px-3 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded text-xs font-medium transition-colors disabled:opacity-50"
        >
          {testing ? '⏳' : '🔄'} Test
        </button>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Status:</span>
          <div className="flex items-center">
            <div className={`w-2 h-2 rounded-full mr-2 ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
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
          <>
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
          </>
        )}

        <div className="pt-2 border-t border-white/10">
          <div className="text-xs text-gray-500">
            Premium RPC endpoint for enhanced performance
          </div>
        </div>
      </div>
    </div>
  )
}

export default ConnectionStatus
