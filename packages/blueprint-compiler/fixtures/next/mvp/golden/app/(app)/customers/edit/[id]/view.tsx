"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { HttpError } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import { Controller } from "react-hook-form";
import * as z from "zod";

import type { CustomerResponse } from "@/api/generated/types.gen";
import { EditView, EditViewHeader } from "@/components/refine-ui/views/edit-view";
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
  fullName: z.string().min(2, "Enter at least 2 characters.").max(120, "Enter at most 120 characters."),
  email: z.email("Enter an email address."),
  status: z.enum(["pending", "active", "suspended"]).optional(),
  creditLimit: z.number().min(0, "Enter 0 or more.").max(1000000, "Enter 1000000 or less.").nullable().optional(),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

export function CustomerEdit({ recordId, initialRecord }: { recordId: string; initialRecord: { data: CustomerResponse } }) {
  const initialValues = customerSchema.partial().safeParse(initialRecord.data);
  const {
    refineCore: { onFinish, formLoading },
    ...form
  } = useForm<CustomerResponse, HttpError, CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      fullName: "",
      email: "",
      status: "pending",
      creditLimit: 0,
      ...(initialValues.success ? initialValues.data : {}),
    },
    refineCoreProps: {
      resource: "customers",
      action: "edit",
      redirect: "list",
      id: recordId,
      queryOptions: { initialData: initialRecord, refetchOnMount: false },
    },
  });

  return (
    <EditView>
      <EditViewHeader />
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => onFinish(values).catch(console.error))}
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
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
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
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            name="status"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-status">Status</FieldLabel>
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
                  <SelectTrigger id="customer-status" aria-invalid={fieldState.invalid}>
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          <Controller
            name="creditLimit"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-credit-limit">Credit limit</FieldLabel>
                <Input
                  {...field}
                  id="customer-credit-limit"
                  type="number"
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </FieldGroup>
        <Button type="submit" disabled={formLoading} className="justify-self-start">
          Save changes
        </Button>
      </form>
    </EditView>
  );
}
