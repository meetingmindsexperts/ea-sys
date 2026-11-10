import type { LucideIcon } from "lucide-react";
import type { PublicBrand } from "@/lib/public-brand";

/**
 * The frame around every sign-in page: the form on the left, the brand panel on
 * the right, under the brand the layout passes (public-brand.ts).
 */
function BrandMark({ brand, className }: { brand: PublicBrand; className: string }) {
  if (!brand.logo) return <span className="text-xl font-semibold text-primary">{brand.name}</span>;
  // An uploaded file, so a plain img: next/image would need its host configured.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={brand.logo} alt={brand.name} className={className} />;
}

export function AuthShell({
  brand,
  tagline,
  tiles,
  children,
}: {
  brand: PublicBrand;
  tagline: string;
  tiles: { icon: LucideIcon; label: string }[];
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex">
      {/* ── Left: form panel ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background">
        <div className="mb-8">
          <BrandMark brand={brand} className="h-auto max-h-24 w-[180px] object-contain" />
        </div>
        {children}
      </div>

      {/* ── Right: brand panel ─────────────────────────────────────────────── */}
      <div className="hidden lg:flex lg:flex-1 bg-gradient-primary items-center justify-center p-8 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute top-20 right-20 w-64 h-64 rounded-full bg-white/5" />
        <div className="absolute bottom-20 left-20 w-48 h-48 rounded-full bg-white/5" />
        <div className="absolute top-1/2 left-1/4 w-32 h-32 rounded-full bg-white/5" />

        <div className="max-w-md text-center text-white relative z-10">
          <div className="inline-flex items-center justify-center bg-white rounded-2xl px-8 py-5 mb-8 shadow-lg">
            <BrandMark brand={brand} className="h-auto max-h-24 w-[180px] object-contain" />
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-white/60 mb-3">{brand.name}</p>
          <p className="text-lg opacity-90 mb-8">{tagline}</p>
          <div className="grid grid-cols-3 gap-4 mt-8">
            {tiles.map(({ icon: Icon, label }) => (
              <div key={label} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/10 backdrop-blur">
                <Icon className="h-6 w-6" />
                <span className="text-sm font-medium">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
