//! Mock HTTP server built from a declarative spec.
//!
//! Self-contained crate. No knock-* dependency so it can be lifted into its
//! own repository. Consumers build a [`MockSpec`] and call [`serve`].

pub mod auth;
pub mod faker;
pub mod server;
pub mod spec;

pub use auth::{AuthError, AuthScheme, JwtIssuer};
pub use faker::{FieldSchema, SchemaType};
pub use server::{serve, serve_with_logger, Handle, LogEntry, LogSink, ServeError};
pub use spec::{MockSpec, ResponseBody, ResponseTemplate, Route};
