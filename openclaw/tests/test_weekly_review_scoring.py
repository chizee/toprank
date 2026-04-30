import sys
import unittest
from pathlib import Path

BIN_DIR = Path(__file__).resolve().parents[1] / "bin"
if str(BIN_DIR) not in sys.path:
    sys.path.insert(0, str(BIN_DIR))

import weekly_review


class WeeklyReviewScoringTest(unittest.TestCase):
    def base_analysis(self) -> dict:
        return {
            "site": "sc-domain:example.com",
            "period": {"start": "2026-04-01", "end": "2026-04-28", "days": 28},
            "summary": {"clicks": 2000, "impressions": 200000, "ctr": 1.0, "position": 8.0},
            "branded_split": {
                "branded": {"clicks": 800, "impressions": 10000},
                "non_branded": {"clicks": 350, "impressions": 20000},
            },
            "comparison": {"declining_pages": [], "declining_queries": []},
            "ctr_gaps_by_page": [],
            "ctr_opportunities": [],
            "cannibalization": [],
        }

    def test_high_impression_ctr_gap_beats_low_volume_utm_drop(self) -> None:
        analysis = self.base_analysis()
        analysis["comparison"]["declining_pages"] = [
            {
                "page": "https://www.example.com/?utm_source=google_map",
                "clicks_now": 3,
                "clicks_prev": 13,
                "change_pct": -76.9,
            }
        ]
        analysis["ctr_gaps_by_page"] = [
            {
                "query": "dog boarding cost",
                "page": "https://www.example.com/blog/dog-boarding-cost",
                "clicks": 2,
                "impressions": 1681,
                "ctr": 0.12,
                "position": 2.8,
            }
        ]

        payload = weekly_review.build_payload("example.com", analysis, {"priors": {}}, None)
        top_action = payload["action_plan"]["actions"][0]
        issues = payload["audit"]["issues"]

        self.assertEqual(top_action["type"], "snippet_content_packaging")
        self.assertEqual(top_action["target"], "https://www.example.com/blog/dog-boarding-cost")
        self.assertIn("business_intent_score", top_action["score_components"])
        self.assertGreater(issues[0]["priority_score"], issues[1]["priority_score"])
        self.assertIn("score_components", issues[0])
        context_request = next(item for item in payload["queue_items"] if item["type"] == "business_context_request")
        proposal = next(item for item in payload["queue_items"] if item["type"] == "action_proposal")
        self.assertEqual(context_request["status"], "pending_input")
        self.assertTrue(context_request["business_context_questions"])
        self.assertEqual(proposal["status"], "pending_approval")
        self.assertIn("complete_business_context", proposal["approval_preconditions"])
        self.assertNotIn("due_at", proposal)

    def test_tracking_url_decline_keeps_raw_target_but_canonicalizes_action_target(self) -> None:
        issue = weekly_review.decline_issue(
            {
                "page": "https://www.example.com/?utm_source=google_map&utm_medium=business_profile",
                "clicks_now": 3,
                "clicks_prev": 13,
                "change_pct": -76.9,
            }
        )

        self.assertEqual(issue["recommended_action_type"], "canonical_or_tracking_investigation")
        self.assertEqual(issue["raw_target"], "https://www.example.com/?utm_source=google_map&utm_medium=business_profile")
        self.assertEqual(issue["target"], "https://www.example.com/")
        self.assertLess(issue["score_components"]["url_quality_score"], 1.0)
        self.assertTrue(any("tracking" in note for note in issue["operator_judgment_notes"]))

    def test_absolute_loss_decline_beats_tiny_percent_drop(self) -> None:
        analysis = self.base_analysis()
        analysis["comparison"]["declining_pages"] = [
            {
                "page": "https://www.example.com/?utm_source=google_map",
                "clicks_now": 3,
                "clicks_prev": 13,
                "change_pct": -76.9,
            },
            {
                "page": "https://www.example.com/blog/dog-sitting-costs",
                "clicks_now": 58,
                "clicks_prev": 103,
                "change_pct": -43.7,
            },
        ]

        payload = weekly_review.build_payload("example.com", analysis, {"priors": {}}, None)
        top_action = payload["action_plan"]["actions"][0]

        self.assertEqual(top_action["target"], "https://www.example.com/blog/dog-sitting-costs")
        self.assertEqual(top_action["type"], "page_improvement")
        self.assertIn("45", top_action["expected_impact"])

    def test_local_commercial_ctr_gap_can_stay_metadata_action(self) -> None:
        issue = weekly_review.ctr_gap_issue(
            {
                "query": "dog boarding seattle",
                "page": "https://www.example.com/dog-boarding-seattle",
                "clicks": 13,
                "impressions": 664,
                "ctr": 1.96,
                "position": 10.7,
            },
            [],
        )

        self.assertEqual(issue["recommended_action_type"], "meta_tags")
        self.assertEqual(issue["score_components"]["business_intent_score"], 1.0)
        self.assertFalse(any("metadata alone is unproven" in note for note in issue["operator_judgment_notes"]))

    def test_informational_ctr_gap_is_not_metadata_only(self) -> None:
        issue = weekly_review.ctr_gap_issue(
            {
                "query": "how much does it cost to board a dog",
                "page": "https://www.example.com/blog/dog-boarding-cost",
                "clicks": 2,
                "impressions": 1681,
                "ctr": 0.12,
                "position": 2.8,
            },
            [],
        )

        self.assertEqual(issue["recommended_action_type"], "snippet_content_packaging")
        self.assertLess(issue["score_components"]["business_intent_score"], 1.0)
        self.assertTrue(any("metadata alone is unproven" in note for note in issue["operator_judgment_notes"]))

    def test_query_only_ctr_gap_is_mapping_not_metadata_action(self) -> None:
        issue = weekly_review.query_ctr_issue(
            {
                "query": "how much does it cost to board a dog",
                "clicks": 2,
                "impressions": 1804,
                "ctr": 0.11,
                "position": 3.5,
            },
            [],
        )

        self.assertEqual(issue["recommended_action_type"], "query_intent_mapping")
        self.assertIn("business_intent_score", issue["score_components"])
        self.assertTrue(any("concrete page" in note for note in issue["operator_judgment_notes"]))

    def test_action_proposal_surfaces_business_context_gaps(self) -> None:
        analysis = self.base_analysis()
        analysis["ctr_gaps_by_page"] = [
            {
                "query": "dog boarding cost",
                "page": "https://www.example.com/blog/dog-boarding-cost",
                "clicks": 2,
                "impressions": 1681,
                "ctr": 0.12,
                "position": 2.8,
            }
        ]

        payload = weekly_review.build_payload("example.com", analysis, {"priors": {}}, None, {"business_name": "Example"})
        context_request = next(item for item in payload["queue_items"] if item["type"] == "business_context_request")
        queue_item = next(item for item in payload["queue_items"] if item["type"] == "action_proposal")
        context_check = next(check for check in payload["verification"]["checks"] if check["name"] == "business impact context")

        self.assertEqual(context_check["status"], "warning")
        self.assertEqual(context_request["status"], "pending_input")
        self.assertEqual(context_request["output_path"], "~/.toprank/business-context/example.com.json")
        self.assertLess(queue_item["business_context_score"], 0.75)
        self.assertIn("complete_business_context", queue_item["approval_preconditions"])
        self.assertTrue(any(gap["field"] == "service_value_weights" for gap in context_request["business_context_gaps"]))
        self.assertTrue(context_request["business_context_questions"])


if __name__ == "__main__":
    unittest.main()
