import { useState } from "react";

import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function KitContainers() {
  const [status, setStatus] = useState<string>("Ready");
  const [tabsValue, setTabsValue] = useState<string>("summary");
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [sheetOpen, setSheetOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  async function handleTabsOnValueChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Tabs>["onValueChange"]>>[0], _value = _event) {
    setTabsValue(_event);
    setStatus(String(_value));
  }

  async function handleDialogOnOpenChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Dialog>["onOpenChange"]>>[0], _value = _event) {
    setDialogOpen(_event);
    setStatus(String(_value));
  }

  async function handleSheetOnOpenChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Sheet>["onOpenChange"]>>[0], _value = _event) {
    setSheetOpen(_event);
    setStatus(String(_value));
  }

  async function handleHelpOnOpenChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Popover>["onOpenChange"]>>[0], _value = _event) {
    setHelpOpen(_event);
    setStatus(String(_value));
  }

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>Containers</h1>
      <Card>
        <CardHeader>
          <p>Card title</p>
        </CardHeader>
        <CardContent>
          <p>Card content</p>
        </CardContent>
        <CardFooter>
          <p>Card footer</p>
        </CardFooter>
      </Card>
      <Tabs
        onValueChange={(event) => void handleTabsOnValueChange(event).catch(console.error)}
        value={tabsValue}
      >
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <p>Account summary</p>
        </TabsContent>
        <TabsContent value="details">
          <p>Account details</p>
        </TabsContent>
      </Tabs>
      <p>{`Active tab: ${tabsValue}`}</p>
      <Dialog
        onOpenChange={(event) => void handleDialogOnOpenChange(event).catch(console.error)}
        open={dialogOpen}
      >
        <DialogTrigger>
          <span>Open dialog</span>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>
            <span>Account dialog</span>
          </DialogTitle>
          <DialogDescription>
            <span>Examples of the dialog.</span>
          </DialogDescription>
        </DialogContent>
      </Dialog>
      <p>{dialogOpen ? "dialog open" : "dialog closed"}</p>
      <Sheet
        onOpenChange={(event) => void handleSheetOnOpenChange(event).catch(console.error)}
        open={sheetOpen}
      >
        <SheetTrigger>
          <span>Open sheet</span>
        </SheetTrigger>
        <SheetContent>
          <SheetTitle>
            <span>Account sheet</span>
          </SheetTitle>
          <SheetDescription>
            <span>Examples of the sheet.</span>
          </SheetDescription>
        </SheetContent>
      </Sheet>
      <p>{sheetOpen ? "sheet open" : "sheet closed"}</p>
      <Popover
        onOpenChange={(event) => void handleHelpOnOpenChange(event).catch(console.error)}
        open={helpOpen}
      >
        <PopoverTrigger>
          <span>Open help</span>
        </PopoverTrigger>
        <PopoverContent>
          <p>Help details</p>
        </PopoverContent>
      </Popover>
      <p>{helpOpen ? "help open" : "help closed"}</p>
      <Separator />
      <p>{status}</p>
    </main>
  );
}
