/** Shared shell for the written pages. Tailwind's typography plugin would be a
 *  dependency for four pages of text; a handful of rules is enough. */
export function Prose(props: { title: string; children: React.ReactNode }) {
  return (
    <article className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground [&_a]:text-primary [&_a:hover]:underline [&_h2]:mt-8 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_strong]:font-semibold [&_strong]:text-foreground">
      <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{props.title}</h1>
      {props.children}
    </article>
  );
}
