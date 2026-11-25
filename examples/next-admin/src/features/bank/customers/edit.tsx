"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { HttpError } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import * as z from "zod";

import type { CustomerDto } from "@/api/generated/types.gen";
import {
  EditView,
  EditViewHeader,
} from "@/components/refine-ui/views/edit-view";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Status and segment are checked together: compliance handles private-banking suspensions.
const customerSchema = z
  .object({
    fullName: z.string().min(2, "Enter at least 2 characters."),
    email: z.email("Enter an email address."),
    status: z.enum(["pending", "active", "suspended"]),
    segment: z.enum(["retail", "private", "business"]),
  })
  .refine((values) => !(values.status === "suspended" && values.segment === "private"), {
    message: "Private banking customers are suspended by compliance, not here.",
    path: ["status"],
  });

type CustomerFormValues = z.infer<typeof customerSchema>;

export function CustomerEdit() {
  const {
    refineCore: { onFinish, formLoading, query },
    ...form
  } = useForm<CustomerDto, HttpError, CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      fullName: "",
      email: "",
      status: "pending",
      segment: "retail",
    },
    refineCoreProps: {
      resource: "customers",
      action: "edit",
      redirect: "list",
    },
  });

  return (
    <EditView>
      <EditViewHeader />
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit(onFinish)}
          className="grid max-w-xl gap-6"
          aria-busy={query?.isLoading}
        >
          <FormField
            control={form.control}
            name="fullName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input {...field} />
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
                  <Input {...field} type="email" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="suspended">Suspended</SelectItem>
                    </SelectContent>
                  </Select>
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
                  <Select value={field.value} onValueChange={field.onChange}>
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
          </div>
          <Button type="submit" disabled={formLoading} className="justify-self-start">
            Save changes
          </Button>
        </form>
      </Form>
    </EditView>
  );
}
