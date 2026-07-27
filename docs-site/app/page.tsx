import type { Metadata } from 'next';
import { LANDING_CSS, LANDING_HTML } from './landing-content';

export const metadata: Metadata = {
  title: "Zug Zug — pin your warehouse's messy values to one record",
  description:
    'Open-source, self-hosted curation for your warehouse: pin messy values like BCG / B.C.G. / Boston Consulting Group to one approved record, keep the reference tables everything depends on, and set up in one command. (The category is master data management — minus the enterprise.)',
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
