import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, type LinkProps } from "react-router-dom";
import "./S-auth.css";

interface AuthBackLinkProps {
  to: string;
  children: ReactNode;
  state?: LinkProps["state"];
}

function AuthBackLink({ to, children, state }: AuthBackLinkProps) {
  return (
    <Link className="auth-back-link" to={to} state={state}>
      <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
      <span>{children}</span>
    </Link>
  );
}

export default AuthBackLink;
