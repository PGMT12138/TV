import React from 'react';
import { useApp } from '../context/AppContext';
import { PageView } from '../types';
import { Film, Search, History, Bookmark, User, Tv } from 'lucide-react';

interface MobileBottomNavProps {
  onOpenProfile: () => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({ onOpenProfile }) => {
  const { currentPage, navigateTo } = useApp();

  const tabs: { id: PageView; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'home', label: '首页', icon: Film },
    { id: 'search', label: '探索', icon: Search },
    { id: 'live', label: '直播', icon: Tv },
    { id: 'history', label: '历史', icon: History },
    { id: 'favorites', label: '收藏', icon: Bookmark },
  ];

  return (
    <nav
      id="mobile-bottom-nav"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-zinc-950/90 backdrop-blur-2xl border-t border-zinc-800/80 px-2 py-1.5 flex items-center justify-around"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = currentPage === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => navigateTo(tab.id)}
            className={`relative flex flex-col items-center justify-center py-1 px-2.5 rounded-xl transition-all ${
              isActive ? 'text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <div className="relative">
              <Icon className={`w-5 h-5 ${isActive ? 'scale-110' : ''} transition-transform`} />
            </div>
            <span className="text-[11px] font-medium mt-1 font-sans-modern">{tab.label}</span>
          </button>
        );
      })}

      {/* User Account Tab */}
      <button
        type="button"
        onClick={onOpenProfile}
        className="relative flex flex-col items-center justify-center py-1 px-2.5 rounded-xl text-zinc-400 hover:text-emerald-400 transition-all"
      >
        <div className="relative">
          <User className="w-5 h-5 transition-transform" />
        </div>
        <span className="text-[11px] font-medium mt-1 font-sans-modern">用户</span>
      </button>
    </nav>
  );
};
