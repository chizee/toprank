# Triggers

The adaptive layer can wake up from three kinds of triggers.

## Scheduled
- `daily_health_check`
- `weekly_review`
- `monthly_strategy_refresh`

## Event-driven
- `traffic_drop_detected`
- `indexing_regression`
- `post_deploy_check`
- `important_page_changed`

## Manual
- `manual_request`
- `improve_this_page`
- `investigate_drop`

For the MVP, scheduled and manual triggers are enough. Event-driven triggers can be represented as queue items or future integrations.
