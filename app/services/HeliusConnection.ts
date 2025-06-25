'use client'

import { Connection, ConnectionConfig } from '@solana/web3.js'

export class HeliusConnection {
  private static instance: Connection | null = null
  private static wsConnection: Connection | null = null

  static getRpcConnection(): Connection {
    if (!this.instance) {
      const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com'
      
      const config: ConnectionConfig = {
        commitment: 'confirmed',
        wsEndpoint: process.env.NEXT_PUBLIC_HELIUS_WS_URL,
        confirmTransactionInitialTimeout: 60000, // 60 seconds
        disableRetryOnRateLimit: false,
      }

      this.instance = new Connection(rpcUrl, config)
      console.log('🚀 Helius RPC connection established:', rpcUrl)
    }
    return this.instance
  }

  static getWebSocketConnection(): Connection {
    if (!this.wsConnection) {
      const wsUrl = process.env.NEXT_PUBLIC_HELIUS_WS_URL || 'wss://api.mainnet-beta.solana.com'
      const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com'
      
      const config: ConnectionConfig = {
        commitment: 'confirmed',
        wsEndpoint: wsUrl,
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: false,
      }

      this.wsConnection = new Connection(rpcUrl, config)
      console.log('📡 Helius WebSocket connection established:', wsUrl)
    }
    return this.wsConnection
  }

  static async testConnection(): Promise<boolean> {
    try {
      const connection = this.getRpcConnection()
      const version = await connection.getVersion()
      console.log('✅ Helius connection test successful:', version)
      return true
    } catch (error) {
      console.error('❌ Helius connection test failed:', error)
      return false
    }
  }

  static async getConnectionStats() {
    try {
      const connection = this.getRpcConnection()
      const [slot, blockHeight, epochInfo] = await Promise.all([
        connection.getSlot(),
        connection.getBlockHeight(),
        connection.getEpochInfo()
      ])

      return {
        currentSlot: slot,
        blockHeight,
        epoch: epochInfo.epoch,
        slotIndex: epochInfo.slotIndex,
        slotsInEpoch: epochInfo.slotsInEpoch
      }
    } catch (error) {
      console.error('Failed to get connection stats:', error)
      return null
    }
  }
}

export default HeliusConnection
