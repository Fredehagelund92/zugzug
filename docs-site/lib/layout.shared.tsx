import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export const gitConfig = {
  user: 'Fredehagelund92',
  repo: 'zugzug',
  branch: 'main',
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span
          className="flex items-center gap-2 font-bold tracking-tight"
          style={{ fontFamily: 'var(--font-display), ui-sans-serif, sans-serif', fontSize: '1.05rem' }}
        >
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 6H25" /><path d="M7 16H25" /><path d="M7 26H25" />
            </g>
            <g stroke="#d6336c" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M25 6L7 16" /><path d="M25 16L7 26" />
            </g>
          </svg>
          Zug Zug<span style={{ color: '#d6336c' }}>.</span>
        </span>
      ),
    },
    links: [{ text: 'Docs', url: '/docs' }],
    themeSwitch: { enabled: true },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
