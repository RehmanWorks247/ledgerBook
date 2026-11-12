import { useContext } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ContactRound,
  Mail,
  Phone,
} from "lucide-react";
import { dateLabel, useResource, type Customer } from "../api";
import { useLedgerMoney as useMoney } from '../currency';
import { Badge, ErrorNotice, Loading, PageHeading } from "../components";
import { Link, Navigate, useParams } from "../router";
import { AuthContext, useOrganization } from "../state";
import { UserFileExplorer } from "../user-files/UserFileExplorer";
import { CustomerBookings } from "./Bookings";

// Available from an empty directory so the preview can be tried without creating a real account.
const sampleUser: Customer = {
  id: "sample",
  name: "Alex Morgan",
  email: "alex@example.com",
  phone: null,
  notes: null,
  status: "active",
  balance_minor: "0",
};

export function UserRecord() {
  const member = useOrganization();
  const { session } = useContext(AuthContext);
  const { customerId } = useParams();
  const root = `/o/${member.organization_id}`;
  const admin = member.role === "admin";
  if (!session || !customerId || (!admin && member.customer_id !== customerId))
    return <Navigate to={root} replace />;

  return (
    <article className="user-record">
      <Link className="record-back" to={admin ? `${root}/users` : root}>
        <ArrowLeft size={15} /> {admin ? "All user records" : "My account"}
      </Link>
      {!admin ? <>
        <PageHeading title="My bookings" description="Your tickets and travel documents in one place." />
        <CustomerBookings customerId={customerId} />
      </> : customerId === sampleUser.id ? (
        <RecordContents
          customer={sampleUser}
          viewerId={session.user.id}
          sample
        />
      ) : (
        <ExistingRecord
          key={JSON.stringify([session.user.id, member.id, customerId])}
          customerId={customerId}
          viewerId={session.user.id}
        />
      )}
    </article>
  );
}

function ExistingRecord({
  customerId,
  viewerId,
}: {
  customerId: string;
  viewerId: string;
}) {
  const { organization_id } = useOrganization();
  const { data, error, loading, refresh } = useResource<Customer>(
    `/organizations/${organization_id}/customers/${encodeURIComponent(customerId)}`,
  );
  if (error)
    return (
      <>
        <h1>User record</h1>
        <ErrorNotice message={error} />
        <button className="button secondary" onClick={refresh}>
          Try again
        </button>
      </>
    );
  if (loading || !data) return <Loading />;
  return <RecordContents customer={data} viewerId={viewerId} />;
}

function RecordContents({
  customer,
  viewerId,
  sample = false,
}: {
  customer: Customer;
  viewerId: string;
  sample?: boolean;
}) {
  const money = useMoney();
  const member = useOrganization();
  const admin = member.role === "admin";
  const root = `/o/${member.organization_id}`;
  const initials = customer.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
  return (
    <>
      <section className="record-profile" aria-labelledby="record-name">
        <header className="record-cover">
          <span className="record-monogram" aria-hidden="true">
            {initials}
          </span>
          <div className="record-identity">
            <span className="record-kicker">
              {sample ? "Sample user record" : customer.customer_code}
            </span>
            <h1 id="record-name">{customer.name}</h1>
            <div className="record-contact">
              <span>
                <Mail size={14} />
                {customer.email}
              </span>
              {customer.phone && (
                <span>
                  <Phone size={14} />
                  {customer.phone}
                </span>
              )}
            </div>
          </div>
          <div className="record-balance">
            <span className="record-kicker">Outstanding balance</span>
            <strong className="money-charge">
              {money(
                customer.balance_minor,
                member.currency,
                member.currency_exponent,
              )}
            </strong>
            {!sample && (
              <Link to={admin ? `${root}/customers/${customer.id}` : root}>
                <BookOpen size={14} /> View account statement
              </Link>
            )}
          </div>
        </header>
        <details className="record-details">
          <summary>
            <span className="record-disclosure">
              <ContactRound size={17} /> Account details
            </span>
            <Badge value={customer.status} />
            <ChevronDown className="record-chevron" size={16} />
          </summary>
          <dl className="record-fields">
            <div>
              <dt>Email address</dt>
              <dd>{customer.email}</dd>
            </div>
            <div>
              <dt>Phone number</dt>
              <dd>{customer.phone || "Not provided"}</dd>
            </div>
            {customer.created_at && (
              <div>
                <dt>Record created</dt>
                <dd>{dateLabel(customer.created_at)}</dd>
              </div>
            )}
            {customer.updated_at && (
              <div>
                <dt>Last updated</dt>
                <dd>{dateLabel(customer.updated_at)}</dd>
              </div>
            )}
            {admin && !sample && (
              <div>
                <dt>Invitation</dt>
                <dd>
                  <Badge value={customer.invitation_status || "not_invited"} />
                </dd>
              </div>
            )}
            {admin && customer.delivery_status && (
              <div>
                <dt>Email delivery</dt>
                <dd>
                  <Badge value={customer.delivery_status} />
                </dd>
              </div>
            )}
            {admin && (
              <div className="record-notes">
                <dt>Internal notes</dt>
                <dd>{customer.notes || "No notes added."}</dd>
              </div>
            )}
          </dl>
        </details>
      </section>
      {sample ? <UserFileExplorer
        viewerId={viewerId}
        organizationId={member.organization_id}
        userId={customer.id}
        canManage={admin}
      /> : <CustomerBookings customerId={customer.id} />}
    </>
  );
}
