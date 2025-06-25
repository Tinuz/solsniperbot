'use client'

import React, { useMemo } from 'react'
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { clusterApiUrl } from '@solana/web3.js'

// Import wallet adapter CSS
import '@solana/wallet-adapter-react-ui/styles.css'

interface WalletProviderProps {
  children: any
}

const WalletProvider = ({ children }: WalletProviderProps) => {
  // Use Helius RPC endpoint for better performance
  const endpoint = useMemo(() => {
    // Check if Helius endpoint is available from environment
    const heliusRpc = process.env.NEXT_PUBLIC_HELIUS_RPC_URL
    if (heliusRpc) {
      console.log('🔗 Using Helius RPC endpoint')
      return heliusRpc
    }
    
    // Fallback to public mainnet
    console.log('🔗 Using public mainnet endpoint')
    return clusterApiUrl(WalletAdapterNetwork.Mainnet)
  }, [])

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    []
  )

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  )
}

export default WalletProvider
