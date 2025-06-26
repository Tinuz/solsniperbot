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
  children: React.ReactNode
}

const WalletProvider = ({ children }: WalletProviderProps) => {
  // Use Helius RPC endpoint for better performance
  const endpoint = useMemo(() => {
    // Check if Helius endpoint is available from environment
    const heliusRpc = process.env.NEXT_PUBLIC_HELIUS_RPC_URL
    if (heliusRpc) {
      return heliusRpc
    }
    
    // Fallback to public mainnet
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
