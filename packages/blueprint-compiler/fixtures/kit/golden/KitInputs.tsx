import { useState } from "react";

import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function KitInputs() {
  const [message, setMessage] = useState<string>("Ready");
  const [searchValue, setSearchValue] = useState<string>("");
  const [notesValue, setNotesValue] = useState<string>("");
  const [segmentValue, setSegmentValue] = useState<string>("Retail");
  const [confirmedChecked, setConfirmedChecked] = useState<boolean>(false);
  const [alertsChecked, setAlertsChecked] = useState<boolean>(false);
  const [channelValue, setChannelValue] = useState<string>("mail");
  const [customerValue, setCustomerValue] = useState<string>("");
  const [birthdayValue, setBirthdayValue] = useState<Date | undefined>(undefined);

  async function handleSearchOnChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Input>["onChange"]>>[0], _value = _event.target.value) {
    setSearchValue(_event.target.value);
    setMessage(String(_value));
  }

  async function handleNotesOnChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Textarea>["onChange"]>>[0], _value = _event.target.value) {
    setNotesValue(_event.target.value);
    setMessage(String(_value));
  }

  async function handleSegmentOnValueChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Select>["onValueChange"]>>[0], _value = _event) {
    setSegmentValue(_event);
    setMessage(String(_value));
  }

  async function handleConfirmedOnCheckedChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Checkbox>["onCheckedChange"]>>[0], _value = _event === true) {
    setConfirmedChecked(_event === true);
    setMessage(String(_value));
  }

  async function handleAlertsOnCheckedChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Switch>["onCheckedChange"]>>[0], _value = _event === true) {
    setAlertsChecked(_event === true);
    setMessage(String(_value));
  }

  async function handleChannelOnValueChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof RadioGroup>["onValueChange"]>>[0], _value = _event) {
    setChannelValue(_event);
    setMessage(String(_value));
  }

  async function handleCustomerOnValueChange(_event: Parameters<NonNullable<import("react").ComponentProps<typeof Command>["onValueChange"]>>[0], _value = _event) {
    setCustomerValue(_event);
    setMessage(String(_value));
  }

  async function handleBirthdayOnSelect(_event: Date | undefined, _value = _event) {
    setBirthdayValue(_event);
    setMessage(_value ? "Date picked" : "No date");
  }

  return (
    <main className="grid max-w-4xl gap-5 p-6">
      <h1>Inputs</h1>
      <Field>
        <Label htmlFor="search-input">Search</Label>
        <Input
          id="search-input"
          onChange={(event) => void handleSearchOnChange(event).catch(console.error)}
          value={searchValue}
        />
      </Field>
      <p>{`Search value: ${searchValue}`}</p>
      <Field>
        <Label htmlFor="notes-input">Notes</Label>
        <Textarea
          id="notes-input"
          onChange={(event) => void handleNotesOnChange(event).catch(console.error)}
          value={notesValue}
        />
      </Field>
      <p>{notesValue}</p>
      <Select
        onValueChange={(event) => void handleSegmentOnValueChange(event).catch(console.error)}
        value={segmentValue}
      >
        <SelectTrigger>
          <SelectValue placeholder="Segment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Retail">
            <span>Retail</span>
          </SelectItem>
          <SelectItem value="Business">
            <span>Business</span>
          </SelectItem>
        </SelectContent>
      </Select>
      <p>{segmentValue}</p>
      <Label htmlFor="confirmed">Confirm</Label>
      <Checkbox
        checked={confirmedChecked}
        id="confirmed"
        onCheckedChange={(event) => void handleConfirmedOnCheckedChange(event).catch(console.error)}
      />
      <p>{confirmedChecked ? "Confirmed" : "Unconfirmed"}</p>
      <Label htmlFor="alerts">Alerts</Label>
      <Switch
        checked={alertsChecked}
        id="alerts"
        onCheckedChange={(event) => void handleAlertsOnCheckedChange(event).catch(console.error)}
      />
      <p>{alertsChecked ? "Alerts on" : "Alerts off"}</p>
      <RadioGroup
        onValueChange={(event) => void handleChannelOnValueChange(event).catch(console.error)}
        value={channelValue}
      >
        <label>
          <RadioGroupItem value="mail" />
          <span>Mail</span>
        </label>
        <label>
          <RadioGroupItem value="phone" />
          <span>Phone</span>
        </label>
      </RadioGroup>
      <p>{channelValue}</p>
      <Popover>
        <PopoverTrigger>{(customerValue) || "Customer"}</PopoverTrigger>
        <PopoverContent>
          <Command>
            <CommandInput placeholder="Customer" />
            <CommandList>
              <CommandEmpty>No matching options</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="Ada"
                  onSelect={() => ((event) => void handleCustomerOnValueChange(event).catch(console.error))("Ada")}
                >
                  Ada
                </CommandItem>
                <CommandItem
                  value="Grace"
                  onSelect={() => ((event) => void handleCustomerOnValueChange(event).catch(console.error))("Grace")}
                >
                  Grace
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p>{customerValue}</p>
      <Popover>
        <PopoverTrigger>{(birthdayValue)?.toLocaleDateString() ?? "Pick a date"}</PopoverTrigger>
        <PopoverContent>
          <Calendar
            mode="single"
            onSelect={(event) => void handleBirthdayOnSelect(event).catch(console.error)}
            selected={birthdayValue}
          />
        </PopoverContent>
      </Popover>
      <p>{birthdayValue ? "Birthday selected" : "Choose a birthday"}</p>
      <p>{message}</p>
    </main>
  );
}
