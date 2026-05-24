import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ClientMountGate } from "@/components/client-mount-gate";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClientMountGate
      fallback={
        <div className="min-h-screen bg-background" suppressHydrationWarning>
          {/* Empty shell during hydration — children mount client-side */}
        </div>
      }
    >
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <a href="#main-content" className="sr-only focus:not-sr-only">
            Skip to content
          </a>
          <main id="main-content" className="relative flex-1 p-6">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </ClientMountGate>
  );
}
