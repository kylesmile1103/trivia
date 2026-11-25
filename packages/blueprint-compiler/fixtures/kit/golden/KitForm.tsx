import { zodResolver } from "@hookform/resolvers/zod"
import type { HttpError } from "@refinedev/core"
import { useForm } from "@refinedev/react-hook-form"
import { Controller } from "react-hook-form"
import { z } from "zod"

import type { CustomerDto } from "@/api/generated/types.gen"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

export function KitForm() {
  const customerSchema = z.object({
    fullName: z.string().min(2, "Enter at least 2 characters."),
    email: z.email("Enter an email address."),
    segment: z.enum(["retail", "private", "business"]),
    notes: z.string().max(1000, "Enter at most 1000 characters.").nullable().optional(),
  })
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
  })

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>New customer</h1>
      <form noValidate={true} onSubmit={form.handleSubmit(onFinish)}>
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Controller
            name="fullName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-form-full-name">Full name</FieldLabel>
                <Input
                  {...field}
                  id="customer-form-full-name"
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
                <FieldLabel htmlFor="customer-form-email">Email</FieldLabel>
                <Input
                  {...field}
                  id="customer-form-email"
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
            name="segment"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-form-segment">Segment</FieldLabel>
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
                  <SelectTrigger id="customer-form-segment" aria-invalid={fieldState.invalid}>
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
          <Controller
            name="notes"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="customer-form-notes">Notes</FieldLabel>
                <Textarea
                  {...field}
                  id="customer-form-notes"
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || undefined)}
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </FieldGroup>
        <Button type="submit" disabled={formLoading}>Create customer</Button>
        <p>Fields marked required must be completed.</p>
      </form>
    </main>
  )
}
