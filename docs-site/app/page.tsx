import type { Metadata } from 'next';
import { LANDING_CSS, LANDING_HTML } from './landing-content';

export const metadata: Metadata = {
  title: 'Zug Zug — master data management, in your warehouse',
  description:
    'Self-hosted master data management that runs next to your warehouse. Pin messy values to one approved record, keep the lists everything depends on, and set up in one command.',
};

// The landing is our design mockup rendered verbatim. Its <style> is inlined
// here (not imported globally), so it only ships on `/` and never touches the
// Fumadocs /docs pages.
export default function Home() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      <div dangerouslySetInnerHTML={{ __html: LANDING_HTML }} />
    </>
  );
}
