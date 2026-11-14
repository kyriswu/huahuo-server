import { Type, type Static } from '@sinclair/typebox';
import { Id, Strict } from '../identity/schemas.js';

const UserStatus = Type.Union([
  Type.Literal('active'), Type.Literal('suspended'), Type.Literal('deleted'),
]);

export const AdminUserQuery = Type.Object({
  search: Type.Optional(Type.String({ maxLength: 120 })),
  status: Type.Optional(UserStatus),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
}, Strict);
export type AdminUserQuery = Static<typeof AdminUserQuery>;

export const AdminUserList = Type.Object({
  items: Type.Array(Type.Object({
    userId: Id,
    displayName: Type.String(),
    phoneMasked: Type.Union([Type.String(), Type.Null()]),
    status: UserStatus,
    createdAt: Type.String({ format: 'date-time' }),
  }, Strict)),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer(),
  pageSize: Type.Integer(),
}, Strict);
export type AdminUserList = Static<typeof AdminUserList>;
