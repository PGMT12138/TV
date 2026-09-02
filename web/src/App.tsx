import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { ToastContainer } from './components/Toast';
import { QuickSearchModal } from './components/QuickSearchModal';
import { UserProfileModal } from './components/UserProfileModal';
import { HomeView } from './views/HomeView';
import { SearchView } from './views/SearchView';
import { DetailView } from './views/DetailView';
import { WatchView } from './views/WatchView';
import { HistoryView } from './views/HistoryView';
import { FavoritesView } from './views/FavoritesView';
import { LoginView } from './views/LoginView';
import { LiveView } from './views/LiveView';

const AuthenticatedApp: React.FC = () => {
  const { currentPage, currentUser, appReady } = useApp();
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  // 启动会话检查完成前显示加载态（避免登录页闪现）
  if (!appReady) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b]">
        <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // If user is not logged in, render the standalone login screen only
  if (!currentUser) {
    return (
      <>
        <LoginView />
        <ToastContainer />
      </>
    );
  }

  // Once authenticated, render the full cinema streaming platform
  return (
    <div className="min-h-screen flex flex-col bg-[#09090b] text-zinc-100 font-sans-modern antialiased selection:bg-emerald-500 selection:text-black">
      {/* Top Desktop Navigation Bar (No Logo/Name, Centered Nav with User Icon) */}
      <Navbar onOpenProfile={() => setProfileModalOpen(true)} />

      {/* Dynamic Page View Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-3 md:pt-6 pb-24 md:pb-12">
        {currentPage === 'home' && <HomeView />}
        {currentPage === 'search' && <SearchView />}
        {currentPage === 'detail' && <DetailView />}
        {currentPage === 'watch' && <WatchView />}
        {currentPage === 'history' && <HistoryView />}
        {currentPage === 'favorites' && <FavoritesView />}
        {currentPage === 'live' && <LiveView />}
      </main>

      {/* Mobile Fixed Bottom Tab Navigation (Including User Icon) */}
      <MobileBottomNav onOpenProfile={() => setProfileModalOpen(true)} />

      {/* User Profile & Account Center Modal (Contains Logout Button & User Info) */}
      <UserProfileModal
        isOpen={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
      />

      {/* Quick Search Overlay Modal (⌘K) */}
      <QuickSearchModal />

      {/* Interactive Toast Notifications */}
      <ToastContainer />
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AuthenticatedApp />
    </AppProvider>
  );
}
