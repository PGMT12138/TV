import React from 'react';
import { useApp } from '../context/AppContext';
import { PageView } from '../types';
import {
  Film,
  Search,
  History,
  Bookmark,
  Compass,
  User,
  Tv,
} from 'lucide-react';

interface NavbarProps {
  onOpenProfile: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onOpenProfile }) => {
  const {
    currentPage,
    navigateTo,
    favorites,
    setSearchModalOpen,
    currentUser,
  } = useApp();

  const navItems: { id: PageView; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'home', label: '首页', icon: Film },
    { id: 'search', label: '探索', icon: Compass },
    { id: 'live', label: '直播', icon: Tv },
    { id: 'history', label: '历史', icon: History },
    { id: 'favorites', label: '收藏', icon: Bookmark },
  ];

  const handleNavClick = (page: PageView) => {
    navigateTo(page);
  };

  return (
    <header
      id="main-navbar"
      className="hidden md:block sticky top-0 z-40 w-full bg-zinc-950/85 backdrop-blur-xl border-b border-zinc-800/70"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 h-18 flex items-center justify-center">
        {/* Desktop Unified Centered Navigation Pill Bar */}
        <nav className="flex items-center gap-1.5 bg-zinc-900/70 p-1.5 rounded-full border border-zinc-800/90 shadow-xl shadow-black/40">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={`relative flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors duration-150 border ${
                  isActive
                    ? 'text-white bg-zinc-800 shadow-sm border-zinc-700/60'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-zinc-400'}`} />
                <span>{item.label}</span>
                {item.id === 'favorites' && favorites.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 bg-indigo-500/20 text-indigo-300 font-bold rounded-full">
                    {favorites.length}
                  </span>
                )}
              </button>
            );
          })}

          {/* Search Button */}
          <button
            type="button"
            onClick={() => setSearchModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800/50 transition-colors duration-150 border border-transparent hover:border-zinc-700/50 group"
          >
            <Search className="w-4 h-4 text-zinc-400 group-hover:text-emerald-400 transition-colors duration-150" />
            <span>搜索</span>
          </button>

          {/* Divider */}
          <div className="h-4 w-px bg-zinc-800 my-auto mx-0.5" />

          {/* User Profile Icon Button in Navigation Bar */}
          {currentUser && (
            <button
              type="button"
              onClick={onOpenProfile}
              className="flex items-center justify-center w-9 h-9 rounded-full text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 transition-colors duration-150 border border-transparent hover:border-zinc-700/50"
              title="用户中心"
              aria-label="User Profile"
            >
              <User className="w-4 h-4" />
            </button>
          )}
        </nav>
      </div>
    </header>
  );
};
