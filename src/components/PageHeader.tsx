import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export default function PageHeader({ title, description, action, className = '' }: PageHeaderProps) {
  return (
    <header className={`page-header ${className}`}>
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {description && <div className="page-subtitle">{description}</div>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  )
}
