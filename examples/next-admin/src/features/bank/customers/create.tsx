"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { HttpError } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Controller } from "react-hook-form";
import * as z from "zod";

import type { CustomerDto } from "@/api/generated/types.gen";
import {
  CreateView,
  CreateViewHeader,
} from "@/components/refine-ui/views/create-view";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const customerSchema = z.object({
  fullName: z.string().min(2, "Enter at least 2 characters."),
  email: z.email("Enter an email address."),
  segment: z.enum(["retail", "private", "business"]),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

export function CustomerCreate() {
  const {
    refineCore: { onFinish, formLoading },
    ...form
  } = useForm<CustomerDto, HttpError, CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      fullName: "",
      email: "",
      segment: "retail",
    },
    refineCoreProps: {
      resource: "customers",
      action: "create",
      redirect: "list",
    },
  });

  return (
    <CreateView>
      <CreateViewHeader />
      <form
        noValidate
        onSubmit={form.handleSubmit(onFinish)}
        className="grid max-w-xl gap-6"
      >
        <FieldGroup>
          <Controller
            name="fullName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-full-name">Full name</FieldLabel>
                <Input
                  {...field}
                  id="customer-full-name"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            name="email"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-email">Email</FieldLabel>
                <Input
                  {...field}
                  id="customer-email"
                  type="email"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            name="segment"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-segment">Segment</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="customer-segment" aria-invalid={fieldState.invalid}>
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">Retail</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </FieldGroup>
        <Button type="submit" disabled={formLoading} className="justify-self-start">
          Create customer
        </Button>
      </form>
    </CreateView>
  );
}
