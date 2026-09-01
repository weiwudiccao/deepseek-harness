/** Authenticated employee identity dictionaries. */

export const NS = 'employeeIdentity'

/** Simplified Chinese dictionary. */
export const zh = {
  'label': '当前员工',
  'designation.unset': '未设置岗位',
} satisfies Record<string, string>

/** Identity dictionary key union. */
export type EmployeeIdentityKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'label': 'Current employee',
  'designation.unset': 'No job title',
} satisfies Record<EmployeeIdentityKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Authenticated employee identity copy. */
    employeeIdentity: EmployeeIdentityKey
  }
}
