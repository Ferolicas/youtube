"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Video, TrendingUp, Users, Image as ImageIcon,
  Flame, Lightbulb, DollarSign, ClipboardCheck, Wand2, FileText,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";

const LINKS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/videos", label: "Vídeos", icon: Video },
  { href: "/outliers", label: "Outliers", icon: Flame },
  { href: "/guion", label: "Guion", icon: FileText },
  { href: "/audience", label: "Audiencia", icon: Users },
  { href: "/thumbnails", label: "Miniaturas", icon: ImageIcon },
  { href: "/trends", label: "Tendencias", icon: TrendingUp },
  { href: "/ideas", label: "Ideas diarias", icon: Lightbulb },
  { href: "/monetization", label: "Monetización", icon: DollarSign },
  { href: "/config-audit", label: "Config & SEO", icon: ClipboardCheck },
  { href: "/recommendations", label: "Reestructuración", icon: Wand2 },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-panel/50 p-3">
      <div className="mb-4 px-2">
        <p className="text-sm font-bold text-accent">Planeta Keto</p>
        <p className="text-xs text-muted">Inteligencia de canal</p>
      </div>
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        const Icon = l.icon;
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel2 hover:text-fg"
            )}
          >
            <Icon size={16} />
            {l.label}
          </Link>
        );
      })}
      <form action="/api/auth/logout" method="post" className="mt-auto">
        <button className="w-full rounded-lg px-3 py-2 text-left text-xs text-muted hover:text-danger">
          Cerrar sesión
        </button>
      </form>
    </nav>
  );
}
