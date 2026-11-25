import { zodResolver } from "@hookform/resolvers/zod";
import type { HttpError } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { z } from "zod";

import type { CustomerDto } from "@/api/generated/types.gen";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function KitForm() {
  const customerSchema = z.object({
    fullName: z.string().min(2, "Enter at least 2 characters."),
    email: z.email("Enter an email address."),
    segment: z.enum(["retail", "private", "business"]),
    notes: z.string().max(1000, "Enter at most 1000 characters.").nullable().optional(),
  });
  const { refineCore: { onFinish, formLoading }, ...form } = useForm<CustomerDto, HttpError, z.infer<typeof customerSchema>>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      fullName: "",
      email: "",
      segment: "retail",
      notes: undefined,
    },
    refineCoreProps: {
      resource: "customers",
      action: "create",
      redirect: "list",
    },
  });

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>New customer</h1>
      <Form {...form}>
        <form noValidate={true} onSubmit={form.handleSubmit(onFinish)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="segment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Segment</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="retail">Retail</SelectItem>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="business">Business</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value || undefined)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <Button type="submit" disabled={formLoading}>Create customer</Button>
          <p>Fields marked required must be completed.</p>
        </form>
      </Form>
    </main>
  );
}
