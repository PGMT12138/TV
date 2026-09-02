import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Film, Lock, User, Eye, EyeOff, ArrowRight, UserPlus } from 'lucide-react';

export const LoginView: React.FC = () => {
  const { login, register, showToast } = useApp();

  const [mode, setMode] = useState<'login' | 'register'>('login');

  // Login form state
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Register form state
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginUsername.trim()) {
      showToast('请输入用户名', 'warning');
      return;
    }
    if (!loginPassword.trim()) {
      showToast('请输入密码', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      await login(loginUsername.trim(), loginPassword.trim());
    } catch (err: any) {
      showToast(err?.message || '登录失败，请检查用户名与密码', 'warning');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regUsername.trim()) {
      showToast('请输入用户名', 'warning');
      return;
    }
    if (!regPassword.trim()) {
      showToast('请设置登录密码', 'warning');
      return;
    }
    if (regPassword.length < 6) {
      showToast('密码长度建议至少6位', 'warning');
      return;
    }

    setIsSubmitting(true);
    try {
      await register(regUsername.trim(), regPassword.trim());
    } catch (err: any) {
      showToast(err?.message || '注册失败', 'warning');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      id="standalone-login-screen"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b] overflow-hidden select-none"
    >
      {/* High-res Cinematic Cinema Background */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <img
          src="https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?q=80&w=2600&auto=format&fit=crop"
          alt="Cinematic Background"
          className="w-full h-full object-cover object-center opacity-30 scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#09090b] via-[#09090b]/80 to-[#09090b]/60" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,#09090b_90%)]" />
      </div>

      {/* Standalone Center Auth Card */}
      <div className="relative z-10 w-full max-w-md mx-4 sm:mx-auto">
        <div className="rounded-3xl bg-zinc-900/90 backdrop-blur-2xl border border-zinc-800/90 p-6 sm:p-8 shadow-2xl shadow-black/80 space-y-5">
          {/* Brand Header */}
          <div className="text-center space-y-1.5">
            <div className="inline-flex items-center justify-center w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shadow-lg shadow-emerald-500/10 mb-0.5">
              <Film className="w-5 h-5" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold font-instrument-serif text-white tracking-wide">
              CINE <span className="font-serif italic font-normal text-emerald-400">极影</span>
            </h1>
            <p className="text-xs text-zinc-400 font-sans-modern">
              影院级 4K 杜比极清流媒体系统
            </p>
          </div>

          {/* Mode Switch Tabs (登录 / 注册) */}
          <div className="grid grid-cols-2 p-1 rounded-2xl bg-zinc-950/80 border border-zinc-800/80">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`py-2 rounded-xl text-xs font-semibold transition-all ${
                mode === 'login'
                  ? 'bg-emerald-500 text-black shadow-md font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              登录账号
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`py-2 rounded-xl text-xs font-semibold transition-all ${
                mode === 'register'
                  ? 'bg-emerald-500 text-black shadow-md font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              快速注册
            </button>
          </div>

          {/* LOGIN FORM */}
          {mode === 'login' ? (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              {/* Username Input */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-zinc-300 font-sans-modern">
                  用户名
                </label>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    required
                    autoFocus
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="请输入用户名"
                    className="w-full bg-zinc-950/90 border border-zinc-800 rounded-2xl pl-10 pr-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 transition-all font-sans-modern"
                  />
                </div>
              </div>

              {/* Password Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-zinc-300 font-sans-modern">
                    密码
                  </label>
                  <button
                    type="button"
                    onClick={() => showToast('账号数据保存在本地服务器，如忘记密码请重新注册一个账号', 'info')}
                    className="text-[11px] text-zinc-400 hover:text-emerald-400 transition-colors"
                  >
                    忘记密码？
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type={showLoginPassword ? 'text' : 'password'}
                    required
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="请输入密码"
                    className="w-full bg-zinc-950/90 border border-zinc-800 rounded-2xl pl-10 pr-10 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 transition-all font-sans-modern"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword(!showLoginPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Remember Me */}
              <div className="flex items-center justify-between pt-0.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-emerald-500 focus:ring-emerald-500 w-3.5 h-3.5"
                  />
                  <span className="text-xs text-zinc-400 select-none">记住登录状态</span>
                </label>
              </div>

              {/* Login Button */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs tracking-wider uppercase transition-all shadow-lg shadow-emerald-500/25 disabled:opacity-60 cursor-pointer active:scale-[0.99] mt-1"
              >
                {isSubmitting ? (
                  <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <span>登 录</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          ) : (
            /* REGISTER FORM */
            <form onSubmit={handleRegisterSubmit} className="space-y-4">
              {/* Username Input */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-zinc-300 font-sans-modern">
                  用户名
                </label>
                <div className="relative">
                  <User className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    required
                    autoFocus
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="请输入注册用户名"
                    className="w-full bg-zinc-950/90 border border-zinc-800 rounded-2xl pl-10 pr-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 transition-all font-sans-modern"
                  />
                </div>
              </div>

              {/* Password Input */}
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-zinc-300 font-sans-modern">
                  设置密码
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type={showRegPassword ? 'text' : 'password'}
                    required
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="设置登录密码（至少6位）"
                    className="w-full bg-zinc-950/90 border border-zinc-800 rounded-2xl pl-10 pr-10 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 transition-all font-sans-modern"
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegPassword(!showRegPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {showRegPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Register Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs tracking-wider uppercase transition-all shadow-lg shadow-emerald-500/25 disabled:opacity-60 cursor-pointer active:scale-[0.99] mt-2"
              >
                {isSubmitting ? (
                  <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <UserPlus className="w-4 h-4" />
                    <span>立即注册并登录</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
