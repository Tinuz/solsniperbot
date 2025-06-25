import './globals.css'

export const metadata = {
  title: 'Sol Sniper Bot',
  description: 'Solana token sniping bot interface',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
