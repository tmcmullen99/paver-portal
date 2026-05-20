# .github/workflows/scheduled-tasks.yml
# BPB Sprints 12C + 15 — Scheduled automation triggers for the nurture cron + daily digest
#
# Hits POST endpoints on portal-baysidepavers.com with the shared secret header.
# The cron times are in UTC. Convert from Pacific:
#   7:00am PDT = 14:00 UTC  (Mar–Nov)
#   7:00am PST = 15:00 UTC  (Nov–Mar)
# We use 15:00 UTC to favor PST (and pick up 8am PDT — close enough).
#
# Required GitHub Actions secrets:
#   BAYSIDE_CRON_SECRET — must match the env var of the same name in Cloudflare Pages.

name: Bayside Portal scheduled tasks

on:
  schedule:
    # Daily digest — weekdays at 15:00 UTC (8am PDT / 7am PST)
    - cron: '0 15 * * 1-5'
    # Nurture cron — every day at 17:00 UTC (10am PDT / 9am PST)
    - cron: '0 17 * * *'
  # Allow manual trigger for testing
  workflow_dispatch:
    inputs:
      task:
        description: 'Which task to run'
        type: choice
        required: true
        options:
          - daily_digest
          - nurture_tick
          - both

jobs:
  daily_digest:
    name: Send daily digest
    runs-on: ubuntu-latest
    if: ${{ github.event.schedule == '0 15 * * 1-5' || github.event.inputs.task == 'daily_digest' || github.event.inputs.task == 'both' }}
    steps:
      - name: POST /api/admin-daily-digest
        run: |
          response=$(curl -sS -w '\nHTTP_STATUS:%{http_code}' -X POST \
            -H "x-bayside-cron-secret: ${{ secrets.BAYSIDE_CRON_SECRET }}" \
            -H "Content-Type: application/json" \
            https://portal-baysidepavers.com/api/admin-daily-digest)
          echo "$response"
          status=$(echo "$response" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
          if [ "$status" != "200" ]; then
            echo "::error::Daily digest returned HTTP $status"
            exit 1
          fi

  nurture_tick:
    name: Run nurture sequence
    runs-on: ubuntu-latest
    if: ${{ github.event.schedule == '0 17 * * *' || github.event.inputs.task == 'nurture_tick' || github.event.inputs.task == 'both' }}
    steps:
      - name: POST /api/admin-nurture-tick
        run: |
          response=$(curl -sS -w '\nHTTP_STATUS:%{http_code}' -X POST \
            -H "x-bayside-cron-secret: ${{ secrets.BAYSIDE_CRON_SECRET }}" \
            -H "Content-Type: application/json" \
            https://portal-baysidepavers.com/api/admin-nurture-tick)
          echo "$response"
          status=$(echo "$response" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
          if [ "$status" != "200" ]; then
            echo "::error::Nurture tick returned HTTP $status"
            exit 1
          fi
