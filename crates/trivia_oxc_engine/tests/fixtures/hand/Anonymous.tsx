import { Button } from "@/components/ui/button";

const banner = <div className="banner">Banner</div>;

export default function () {
  return (
    <main>
      {banner}
      <Button>Go</Button>
      <Button variant="outline">
        Back
      </Button>
    </main>
  );
}
