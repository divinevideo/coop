import importlib.util
import pathlib
import unittest
spec = importlib.util.spec_from_file_location('setup', pathlib.Path(__file__).with_name('coop_setup_concord.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class ProvisionTest(unittest.TestCase):
    def test_idempotent_room_only_configuration(self):
        state = {'itemTypes': [{'id': 'existing', 'name': 'nostr_event'}], 'mrtQueues': [{'id': 'existing-queue', 'name': 'General Review'}], 'routingRules': [], 'actions': [{'id': 'global', 'name': 'Ban-User'}]}
        mutations = []
        def gql(query, variables=None):
            if query.startswith('query'): return {'myOrg': state}
            value = variables['input']
            key = next(k for k in ('createContentItemType','createUserItemType','createManualReviewQueue','createRoutingRule','createAction') if k in query)
            collection = {'createContentItemType':'itemTypes','createUserItemType':'itemTypes','createManualReviewQueue':'mrtQueues','createRoutingRule':'routingRules','createAction':'actions'}[key]
            row = dict(value, id=f'{collection}-{len(state[collection])}')
            state[collection].append(row); mutations.append((key, value))
            return {key: {'__typename': {'createContentItemType':'MutateContentTypeSuccessResponse','createUserItemType':'MutateUserTypeSuccessResponse','createManualReviewQueue':'MutateManualReviewQueueSuccessResponse','createRoutingRule':'MutateRoutingRuleSuccessResponse','createAction':'MutateActionSuccessResponse'}[key]}}
        setup.provision(gql, 'https://moderation.example', ['synthetic-reviewer'])
        count = len(mutations)
        setup.provision(gql, 'https://moderation.example', ['synthetic-reviewer'])
        self.assertEqual(len(mutations), count)
        self.assertEqual(state['actions'][0], {'id': 'global', 'name': 'Ban-User'})
        self.assertEqual(state['mrtQueues'][0], {'id': 'existing-queue', 'name': 'General Review'})
        queue = next(x for x in state['mrtQueues'] if x['name'] == 'Room Review')
        self.assertFalse(queue['autoCloseJobs']); self.assertEqual(queue['userIds'], ['synthetic-reviewer'])
        room_ids = [x['id'] for x in state['itemTypes'] if x['name'].startswith('concord_')]
        self.assertEqual(len(room_ids), 2)
        for action in state['actions'][1:]:
            self.assertTrue(set(action['itemTypeIds']).issubset(room_ids))
            self.assertEqual(action['callbackUrl'], 'https://moderation.example/v1/decisions')
            self.assertNotIn('callbackUrlHeaders', action)
        for route in state['routingRules']: self.assertEqual(route['destinationQueueId'], queue['id'])

    def test_missing_staff_and_invalid_origin_fail_without_mutation(self):
        for origin, reviewers in [('http://example.invalid',['staff']), ('https://example.invalid/path',['staff']), ('https://example.invalid',[])]:
            with self.assertRaises(ValueError): setup.provision(lambda *_: self.fail('must not query'), origin, reviewers)

if __name__ == '__main__': unittest.main()
