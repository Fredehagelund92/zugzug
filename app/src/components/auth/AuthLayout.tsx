import type { ReactNode } from "react";
import { BrandCover } from "./BrandCover";

/* Split auth shell: brand cover (lattice + convergence motif) on the left,
   the form column on the right. Below the md breakpoint (768px) the grid
   drops to one column and BrandCover hides itself, leaving a centered form.
   See DESIGN.md §3 (brand constants hold across themes) and
   docs/ui-demos/01-login.html. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[1.05fr_0.95fr]">
      <BrandCover />
      <section className="grid place-items-center bg-bg px-6 py-12">
        <div className="w-full max-w-[360px]">{children}</div>
      </section>
    </div>
  );
}
