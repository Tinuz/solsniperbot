'use client'

import React from 'react'
import dynamic from 'next/dynamic'

// Dynamically import the MainInterface to avoid hydration issues
const MainInterface = dynamic(() => import('./MainInterface'), {
  ssr: false,
  loading: () => (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white/10 backdrop-blur-md rounded-xl p-6 mb-6">
        <div className="animate-pulse">
          <div className="h-8 bg-white/20 rounded w-1/3 mb-4"></div>
          <div className="h-12 bg-white/20 rounded"></div>
        </div>
      </div>
      <div className="bg-white/10 backdrop-blur-md rounded-xl p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-white/20 rounded w-1/4"></div>
          <div className="h-12 bg-white/20 rounded"></div>
          <div className="h-12 bg-white/20 rounded"></div>
          <div className="h-12 bg-white/20 rounded"></div>
          <div className="h-12 bg-white/20 rounded"></div>
        </div>
      </div>
    </div>
  )
})

export default MainInterface
