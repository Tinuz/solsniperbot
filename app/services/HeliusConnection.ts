import { Connection, ConnectionConfig } from '@solana/web3.js'

export class HeliusConnection {
  // Configuration constants
  private static readonly DEFAULT_TIMEOUT_MS = 5000
  private static readonly RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com'
  private static readonly WS_URL = process.env.NEXT_PUBLIC_HELIUS_WS_URL || 'wss://api.mainnet-beta.solana.com'
  
  private static instance: Connection | null = null
  private static wsConnection: Connection | null = null
  private static activeSubscriptions: Set<number> = new Set()

  static getRpcConnection(): Connection {
    if (!this.instance) {
      const config: ConnectionConfig = {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000, // 60 seconds
        disableRetryOnRateLimit: false,
      }

      this.instance = new Connection(this.RPC_URL, config)
    }
    return this.instance
  }

  static getWebSocketConnection(): Connection {
    if (!this.wsConnection) {
      const config: ConnectionConfig = {
        commitment: 'confirmed',
        wsEndpoint: this.WS_URL,
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
        // Add WebSocket-specific configuration for better error handling
        httpHeaders: {
          'User-Agent': 'SolSniperBot/1.0'
        }
      }

      this.wsConnection = new Connection(this.RPC_URL, config)
    }
    return this.wsConnection
  }

  static addSubscription(id: number) {
    this.activeSubscriptions.add(id)
  }

  static removeSubscription(id: number) {
    if (this.activeSubscriptions.has(id)) {
      this.activeSubscriptions.delete(id)
      return true
    } else {
      return false
    }
  }

  static async safeRemoveSubscription(id: number): Promise<boolean> {
    try {
      const connection = this.getWebSocketConnection()
      
      // Check if we're tracking this subscription
      if (!this.activeSubscriptions.has(id)) {
        return false
      }
      
      // Ensure removeOnLogsListener is properly awaited as Promise
      await Promise.resolve(connection.removeOnLogsListener(id))
      this.removeSubscription(id)
      return true
    } catch (error: unknown) {
      // Always remove from tracking, even on error, to prevent leaks
      this.removeSubscription(id)
      
      // Handle specific error messages
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage?.includes('could not be found') || 
          errorMessage?.includes('Ignored unsubscribe')) {
        return true
      } else {
        console.warn(`Error removing subscription ${id}:`, errorMessage)
        return false
      }
    }
  }

  static getActiveSubscriptions(): number[] {
    return Array.from(this.activeSubscriptions)
  }

  static async testConnection(): Promise<boolean> {
    try {
      const connection = this.getRpcConnection()
      
      // Use centralized timeout for consistency
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection test timeout')), this.DEFAULT_TIMEOUT_MS)
      )
      
      await Promise.race([
        connection.getVersion(),
        timeout
      ])
      
      return true
    } catch (error: unknown) {
      // Don't log full errors for rate limiting to reduce noise
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage?.includes('429') || errorMessage?.includes('rate limit')) {
        console.warn('Connection test rate limited (will retry later)')
      } else {
        console.warn('Helius connection test failed:', errorMessage)
      }
      return false
    }
  }

  static async lightConnectionTest(): Promise<boolean> {
    try {
      const connection = this.getRpcConnection()
      
      // Use an even lighter call - just check if connection object exists and has required methods
      if (!connection || typeof connection.getLatestBlockhash !== 'function') {
        return false
      }
      
      // Use centralized timeout for consistency
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Light connection test timeout')), this.DEFAULT_TIMEOUT_MS)
      )
      
      // Try the lightest RPC call with centralized timeout
      await Promise.race([
        connection.getLatestBlockhash('finalized'),
        timeout
      ])
      
      return true
    } catch {
      // Silently handle rate limiting and connection errors
      // Don't log anything to avoid console noise
      return false
    }
  }

  static async getConnectionStats() {
    try {
      const connection = this.getRpcConnection()
      
      // Try to get basic connection info with centralized timeout
      const timeout = (ms: number = this.DEFAULT_TIMEOUT_MS) => new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Request timeout')), ms)
      )
      
      // Race each call against centralized timeout (doubled for stats gathering)
      const [slot, blockHeight, epochInfo] = await Promise.allSettled([
        Promise.race([connection.getSlot(), timeout(this.DEFAULT_TIMEOUT_MS * 2)]),
        Promise.race([connection.getBlockHeight(), timeout(this.DEFAULT_TIMEOUT_MS * 2)]),
        Promise.race([connection.getEpochInfo(), timeout(this.DEFAULT_TIMEOUT_MS * 2)])
      ])

      // Extract successful results
      const result: {
        currentSlot?: number;
        blockHeight?: number;
        epoch?: number;
        slotIndex?: number;
        slotsInEpoch?: number;
      } = {}
      
      if (slot.status === 'fulfilled') {
        result.currentSlot = slot.value as number
      }
      
      if (blockHeight.status === 'fulfilled') {
        result.blockHeight = blockHeight.value as number
      }
      
      if (epochInfo.status === 'fulfilled') {
        const epoch = epochInfo.value as { epoch: number; slotIndex: number; slotsInEpoch: number }
        result.epoch = epoch.epoch
        result.slotIndex = epoch.slotIndex
        result.slotsInEpoch = epoch.slotsInEpoch
      }

      // Return partial results if we got at least one successful call
      if (Object.keys(result).length > 0) {
        return result
      } else {
        throw new Error('All connection stat calls failed')
      }
      
    } catch (error) {
      console.warn('Failed to get connection stats:', error)
      return null
    }
  }

  static resetConnections() {
    // Clean up any tracked subscriptions
    if (this.activeSubscriptions.size > 0) {
      this.activeSubscriptions.clear()
    }
    
    this.instance = null
    this.wsConnection = null
  }

  static resetWebSocketConnection() {
    // Clean up subscriptions when resetting WebSocket
    if (this.activeSubscriptions.size > 0) {
      this.activeSubscriptions.clear()
    }
    
    this.wsConnection = null
  }

  static validateConfiguration(): boolean {
    try {
      // Basic validation using centralized configuration
      const hasRpcUrl = this.RPC_URL && this.RPC_URL.length > 0 && this.RPC_URL !== 'https://api.mainnet-beta.solana.com'
      const hasWsUrl = this.WS_URL && this.WS_URL.length > 0 && this.WS_URL !== 'wss://api.mainnet-beta.solana.com'
      
      return Boolean(hasRpcUrl && hasWsUrl)
    } catch (error) {
      console.warn('Configuration validation failed:', error)
      return false
    }
  }
}

export default HeliusConnection
