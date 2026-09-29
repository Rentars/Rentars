'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/auth/use-auth';
import { WalletAuthButton } from '@/components/auth/WalletAuthButton';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { LocaleSwitcher } from '@/components/shared/LocaleSwitcher';
import NotificationBell from '@/components/shared/NotificationBell';
import { ConnectionStatusIndicator } from '@/components/shared/ConnectionStatusIndicator';
import { useOptionalRealtimeConnection } from '@/components/shared/RealtimeProvider';
import { useTranslations } from '@/lib/i18n/useTranslations';
import { House, Menu, X, LogOut, User } from 'lucide-react';
import { WalletConnectButton } from '@/components/wallet';
import { WalletStatusBadge } from '@/components/wallet';

export function Navbar() {
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const t = useTranslations('nav');
  const { connectionStatus, retryAttempt, retriesRemaining } = useOptionalRealtimeConnection();

  const navLinks = [
    { href: '/', label: t('home') },
    { href: '/search', label: t('search') },
    { href: '/list', label: t('listProperty') },
    { href: '/dashboard', label: t('dashboard') },
  ];

  return (
      <nav className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2 font-bold text-xl text-gray-900 dark:text-white">
              <House className="text-blue-600" size={24} />
              <span>Rentars</span>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center gap-8">
              {navLinks.map((link) => (
                  <Link
                      key={link.href}
                      href={link.href}
                      className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition font-medium"
                  >
                    {link.label}
                  </Link>
              ))}
            </div>

            {/* Right Section */}
            <div className="flex items-center gap-3">
              <LocaleSwitcher />
              <ThemeToggle />

              {/* Live-connection state. Surfaces stale/reconnecting so the UI
                  never looks current while data is out of date. */}
              <ConnectionStatusIndicator
                  status={connectionStatus}
                  showLabel
                  retryAttempt={retryAttempt}
                  retriesRemaining={retriesRemaining}
              />

              {/* Wallet Status Badge - shows network and address */}
              <WalletStatusBadge className="hidden md:flex" />

              {user ? (
                  <div className="hidden md:flex items-center gap-3">
                    <NotificationBell userId={user.id} />
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                      <User size={18} className="text-gray-600 dark:text-gray-300" />
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{user.name}</span>
                    </div>
                    <button
                        onClick={logout}
                        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
                        title={t('logout')}
                    >
                      <LogOut size={18} className="text-gray-600 dark:text-gray-300" />
                    </button>
                  </div>
              ) : (
                  <div className="hidden md:block">
                    {/* Replace WalletAuthButton with our new wallet connect button */}
                    <WalletConnectButton />
                  </div>
              )}

              {/* Mobile Menu Button */}
              <button
                  onClick={() => setIsOpen(!isOpen)}
                  className="md:hidden p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
                  aria-label={isOpen ? 'Close menu' : 'Open menu'}
              >
                {isOpen ? (
                    <X size={24} className="text-gray-900 dark:text-white" />
                ) : (
                    <Menu size={24} className="text-gray-900 dark:text-white" />
                )}
              </button>
            </div>
          </div>

          {/* Mobile Navigation */}
          {isOpen && (
              <div className="md:hidden pb-4 space-y-2">
                {navLinks.map((link) => (
                    <Link
                        key={link.href}
                        href={link.href}
                        className="block px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
                        onClick={() => setIsOpen(false)}
                    >
                      {link.label}
                    </Link>
                ))}

                {/* Mobile wallet status */}
                <div className="px-4 py-2">
                  <WalletStatusBadge className="flex" />
                </div>

                {!user && (
                    <div className="px-4 py-2">
                      <WalletConnectButton className="w-full justify-center" />
                    </div>
                )}
                {user && (
                    <button
                        onClick={() => {
                          logout();
                          setIsOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition flex items-center gap-2"
                    >
                      <LogOut size={18} />
                      {t('logout')}
                    </button>
                )}
              </div>
          )}
        </div>
      </nav>
  );
}