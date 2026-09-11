import WorkflowListPage from "@/components/workflow/workflow-list-page";
import { getSession } from "auth/server";
import { redirect } from "next/navigation";
import { toDomainRole } from "lib/policy";

// Force dynamic rendering to avoid static generation issues with session
export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }

  const domainRole = toDomainRole(session.user.role);
  if (domainRole !== "employee") {
    redirect("/");
  }

  return <WorkflowListPage userRole={session.user.role} />;
}
