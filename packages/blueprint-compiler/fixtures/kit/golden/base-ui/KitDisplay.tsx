import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@base/components/ui/alert";
import { Avatar, AvatarFallback } from "@base/components/ui/avatar";
import { Badge } from "@base/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@base/components/ui/breadcrumb";
import { Button } from "@base/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@base/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "@base/components/ui/empty";
import { Skeleton } from "@base/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@base/components/ui/tooltip";

export function KitDisplay() {
  const [status, setStatus] = useState<string>("Ready");

  async function handleRefreshOnClick(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Button>["onClick"]>>[0], _value = _event) {
    setStatus("Refreshed");
  }

  async function handleMenuOnOpenChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof DropdownMenu>["onOpenChange"]>>[0], _value = _event) {
    setStatus(_value ? "Menu open" : "Menu closed");
  }

  async function handleTooltipOnOpenChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Tooltip>["onOpenChange"]>>[0], _value = _event) {
    setStatus(_value ? "Help open" : "Help closed");
  }

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>Actions and display</h1>
      <Button onClick={(event) => void handleRefreshOnClick(event).catch(console.error)}>
        Refresh
      </Button>
      <Badge>{status}</Badge>
      <DropdownMenu
        onOpenChange={(event) => void handleMenuOnOpenChange(event).catch(console.error)}
      >
        <DropdownMenuTrigger>
          <span>More actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            <span>Export</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Avatar>
        <AvatarFallback>
          <span>AL</span>
        </AvatarFallback>
      </Avatar>
      <Alert>
        <AlertTitle>
          <span>Notice</span>
        </AlertTitle>
        <AlertDescription>
          <span>The kit is ready.</span>
        </AlertDescription>
      </Alert>
      <Tooltip onOpenChange={(event) => void handleTooltipOnOpenChange(event).catch(console.error)}>
        <TooltipTrigger>
          <span>Help</span>
        </TooltipTrigger>
        <TooltipContent>
          <span>Help for display components</span>
        </TooltipContent>
      </Tooltip>
      <Skeleton className="h-4 w-24" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>
              <span>Display</span>
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <span>Nothing here yet</span>
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
