import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import {
  LogOut,
  Clock,
  Calendar,
  X,
  User,
} from 'lucide-react';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({ isOpen, onClose }) => {
  const { currentUser, logout } = useApp();
  const [showConfirmLogout, setShowConfirmLogout] = useState(false);

  if (!isOpen || !currentUser) return null;

  const handleLogout = () => {
    onClose();
    setShowConfirmLogout(false);
    logout();
  };

  return (
    <div
      id="user-profile-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-blur"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-7 shadow-2xl space-y-6 text-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>

        {/* User Info Header (User Icon + Username) */}
        <div className="flex items-center gap-4 pr-6">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center shadow-lg shadow-emerald-500/10 shrink-0">
            <User className="w-7 h-7" />
          </div>

          <div className="min-w-0">
            <div className="text-xs text-zinc-400 font-sans-modern">当前登录用户</div>
            <h3 className="text-lg font-bold text-white truncate font-sans-modern mt-0.5">
              {currentUser.name}
            </h3>
          </div>
        </div>

        {/* User Stats Grid (观影时长 & 注册时间) */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3.5 rounded-2xl bg-zinc-950/80 border border-zinc-800/80">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Clock className="w-3.5 h-3.5 text-emerald-400" />
              <span>观影时长</span>
            </div>
            <div className="text-lg font-bold text-white font-mono mt-1">
              {currentUser.watchTimeHours} <span className="text-xs font-normal text-zinc-500">小时</span>
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-zinc-950/80 border border-zinc-800/80">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Calendar className="w-3.5 h-3.5 text-indigo-400" />
              <span>注册时间</span>
            </div>
            <div className="text-sm font-bold text-white font-mono mt-1.5">
              {currentUser.joinedDate}
            </div>
          </div>
        </div>

        {/* Logout Confirmation & Actions */}
        <div className="pt-2 border-t border-zinc-800/80">
          {showConfirmLogout ? (
            <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 space-y-3">
              <p className="text-xs text-rose-300 font-medium text-center">
                确定要退出当前账号吗？退出后需重新登录。
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowConfirmLogout(false)}
                  className="flex-1 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleLogout}
                  className="flex-1 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white font-bold text-xs transition-colors flex items-center justify-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>确认退出</span>
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowConfirmLogout(true)}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-zinc-950 hover:bg-rose-500/15 text-zinc-400 hover:text-rose-300 border border-zinc-800 hover:border-rose-500/40 text-xs font-semibold transition-all duration-200"
            >
              <LogOut className="w-4 h-4" />
              <span>退出登录账号</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
