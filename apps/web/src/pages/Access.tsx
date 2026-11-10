import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Mail,
  RefreshCw,
  ShieldOff,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";
import { Link, Navigate } from "../router";
import { AuthContext, useOrganization } from "../state";
import { errorMessage, mutate, useResource } from "../api";
import { Badge, Empty, ErrorNotice, TableSkeleton, PageHeading } from "../components";
import { DeleteAccountDialog } from "../DeleteAccountDialog";

type WorkspaceUser = {
  id: string;
  user_id: string;
  email: string;
  name: string | null;
  role: "admin" | "customer";
  is_active: boolean;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  created_at: string;
};
type UserAction = "disable" | "enable" | "delete";
export function UsersPage() {
  const organization = useOrganization();
  if (organization.role !== "admin")
    return <Navigate to={`/o/${organization.organization_id}`} replace />;
  return <UserManagement />;
}
function UserManagement() {
  const organization = useOrganization();
  const { session } = useContext(AuthContext);
  const base = `/organizations/${organization.organization_id}/users`;
  const { data, loading, error, refresh } = useResource<{
    users: WorkspaceUser[];
  }>(base, { cache: true });
  const [selection, setSelection] = useState<{
    user: WorkspaceUser;
    action: UserAction;
  }>();
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const users = data?.users.filter((user) =>
    `${user.email} ${user.name || ""} ${user.customer_name || ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  function finishAction() {
    if (!selection) return;
    const { user, action } = selection;
    setNotice(
      action === "delete"
        ? user.customer_id
          ? `${user.customer_email}: customer account and its data permanently deleted. You can invite this email again to create a new account.`
          : `${user.email}: administrator access permanently removed.`
        : `${user.email}: ${action === "disable" ? "access disabled" : "access enabled"}.`,
    );
    setSelection(undefined);
    refresh();
  }
  return (
    <>
      <PageHeading
        title="Users & access"
        description="Manage invitations and account access."
        actions={
          <Link
            className="button"
            to={`/o/${organization.organization_id}/customers/new`}
          >
            <Mail size={18} />
            Invite customer
          </Link>
        }
      />
      <ErrorNotice message={error} />
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <section className="panel">
        <div className="users-toolbar">
          <label className="users-search">
            Find a user
            <input
              type="search"
              placeholder="Name or email address"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="button secondary"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
        {loading && !data ? (
          <TableSkeleton columns={["User", "Role", "Access", "Customer account", "Actions"]} label="Loading users and access" />
        ) : users?.length ? (
          <div className="table-scroll" aria-busy={loading}>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Access</th>
                  <th>Customer account</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="customer-cell">
                        <span className="customer-avatar">
                          {(user.name || user.customer_name || user.email)
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                        <span>
                          <strong>
                            {user.name || user.customer_name || user.email}
                            {user.user_id === session?.user.id ? " (you)" : ""}
                          </strong>
                          <small>{user.email}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <Badge value={user.role} />
                    </td>
                    <td>
                      <Badge value={user.is_active ? "active" : "disabled"} />
                    </td>
                    <td>
                      {user.customer_id ? (
                        <Link
                          to={`/o/${organization.organization_id}/customers/${user.customer_id}`}
                        >
                          {user.customer_name || "View account"}
                        </Link>
                      ) : (
                        <span className="muted">Business administrator</span>
                      )}
                    </td>
                    <td>
                      <div className="user-actions">
                        <button
                          className="text-link"
                          disabled={user.user_id === session?.user.id}
                          onClick={() =>
                            setSelection({
                              user,
                              action: user.is_active ? "disable" : "enable",
                            })
                          }
                        >
                          {user.is_active ? (
                            <ShieldOff size={15} />
                          ) : (
                            <UserCheck size={15} />
                          )}
                          {user.is_active ? "Disable" : "Enable"}
                        </button>
                        <button
                          className="text-link danger-text"
                          disabled={
                            user.user_id === session?.user.id ||
                            Boolean(user.customer_id && !user.customer_email)
                          }
                          onClick={() =>
                            setSelection({ user, action: "delete" })
                          }
                        >
                          <Trash2 size={15} />
                          Delete permanently
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          data && (
            <Empty
              title={query ? "No matching users" : "No users yet"}
              detail={
                query
                  ? "Try another name or email address."
                  : "Invite a customer to let them create their own password and join."
              }
            />
          )
        )}
      </section>
      <p className="small muted">
        Pending invitations appear on customer accounts. Open a customer to
        resend or revoke their invitation.
      </p>
      {selection?.action === "delete" && (
        <DeleteAccountDialog
          name={
            selection.user.customer_name ||
            selection.user.name ||
            selection.user.email
          }
          email={
            selection.user.customer_id
              ? selection.user.customer_email!
              : selection.user.email
          }
          kind={selection.user.customer_id ? "customer" : "administrator"}
          organizationName={organization.organization_name}
          path={
            selection.user.customer_id
              ? `/organizations/${organization.organization_id}/customers/${selection.user.customer_id}`
              : `${base}/${selection.user.id}`
          }
          onClose={() => setSelection(undefined)}
          onDeleted={finishAction}
        />
      )}
      {selection && selection.action !== "delete" && (
        <UserActionDialog
          user={selection.user}
          action={selection.action}
          base={base}
          onClose={() => setSelection(undefined)}
          onSaved={finishAction}
        />
      )}
    </>
  );
}
function UserActionDialog({
  user,
  action,
  base,
  onClose,
  onSaved,
}: {
  user: WorkspaceUser;
  action: Exclude<UserAction, "delete">;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate(`${base}/${user.id}/${action}`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const label = action === "disable" ? "Disable user" : "Enable user";
  return (
    <dialog
      ref={dialog}
      className="entry-dialog"
      aria-labelledby="user-action-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">{user.email}</span>
          <h2 id="user-action-title">{label}?</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close user action"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      <ErrorNotice message={error} />
      <form className="stack-form" onSubmit={submit} aria-busy={busy}>
        <p>
          {action === "disable"
            ? "This user will lose access to this workspace immediately. You can enable their access again later. Their customer record and financial history will be kept."
            : "This user will be able to sign in and access this workspace again."}
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={`button ${action !== "enable" ? "danger-button" : ""}`}
            disabled={busy}
          >
            {busy ? "Saving…" : label}
          </button>
        </div>
      </form>
    </dialog>
  );
}
